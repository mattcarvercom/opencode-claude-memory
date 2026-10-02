import { afterEach, describe, expect, test } from "bun:test"
import {
  buildConversationForExtraction,
  ExtractionCoordinator,
  hasExtractableUserMessage,
  MAX_EXTRACTION_FAILURES,
  sliceNewMessages,
  trimIncompleteTail,
} from "../../src/extraction/ExtractionCoordinator.js"
import { MaintenanceLock } from "../../src/extraction/lock.js"
import { EXTRACT_EXISTING_MEMORIES_HEADING } from "../../src/extraction/prompts.js"
import { ExtractionStateStore } from "../../src/extraction/state.js"
import type { SessionMessage } from "../../src/sdk.js"
import {
  cleanupTempDirs,
  collectingLog,
  deferred,
  deps,
  type GenerateCall,
  makeConfig,
  makeGenerate,
  makeSessions,
  makeStore,
  memoriesReply,
  type Reply,
  seedMemory,
  sessionAssistant,
  sessionUser,
  textPart,
  toolPart,
} from "../helpers/index.js"

afterEach(cleanupTempDirs)

type Conversations = Record<string, SessionMessage[]>

function setup(
  options: { conversations?: Conversations; config?: Record<string, unknown>; replies?: Reply | Reply[] } = {},
) {
  const store = makeStore()
  const config = makeConfig(
    { extract: { debounceMs: 0, timeoutMs: 200 }, autodream: { enabled: false }, ...options.config },
    store.claudeConfigDir,
  )
  const model = makeGenerate(options.replies ?? '{"memories": []}')
  const sessions = makeSessions(store.memoryRoot, options.conversations ?? {})
  const { log, entries } = collectingLog()
  let now = 1_000_000
  const state = new ExtractionStateStore(store.stateDir, () => now)
  const coordinator = new ExtractionCoordinator({
    ...deps({ store, config, generate: model.generate, sessions, log, now: () => now }),
    state,
    // Liveness probe injected so lock tests do not depend on which PIDs exist on the runner.
    lock: new MaintenanceLock(
      state.lockPath,
      () => now,
      4242,
      () => true,
    ),
  })
  const conversations = sessions.messages
  const tick = (ms: number) => {
    now += ms
  }
  return { store, config, model, sessions, conversations, entries, state, coordinator, tick, now: () => now }
}

const idleEvent = (sessionID: string) => ({ type: "session.idle", data: { sessionID } })

async function idle(coordinator: ExtractionCoordinator, sessionID: string): Promise<void> {
  coordinator.onEvent(idleEvent(sessionID))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await coordinator.idle()
}

const promptOf = (call: GenerateCall | undefined) => call?.prompt ?? ""

// Two messages per turn with explicit ids and times: u<n> at n*10, a<n> completing at n*10+8.
function turn(sessionID: string, n: number, userText: string, assistantText = `Noted, turn ${n}.`): SessionMessage[] {
  return [
    sessionUser(userText, n * 10, `${sessionID}_u${n}`),
    sessionAssistant([textPart(assistantText)], { created: n * 10 + 5, id: `${sessionID}_a${n}` }),
  ].map((m) => (m.type === "assistant" ? { ...m, time: { created: n * 10 + 5, completed: n * 10 + 8 } } : m))
}

const conversation = (sessionID: string, turns: number): SessionMessage[] => {
  const out: SessionMessage[] = []
  for (let i = 1; i <= turns; i++) {
    out.push(sessionUser(`I prefer PostgreSQL for everything, turn ${i}.`, i * 10, `${sessionID}_u${i}`))
    out.push({
      ...sessionAssistant([textPart(`Noted, turn ${i}.`), toolPart("grep", "match")], { id: `${sessionID}_a${i}` }),
      time: { created: i * 10 + 5, completed: i * 10 + 8 },
    })
  }
  return out
}

describe("ExtractionCoordinator incremental extraction", () => {
  test("session.idle runs one extraction over the whole conversation, saves the memories and records the watermark", async () => {
    const reply = memoriesReply({ fileName: "feedback_postgres", type: "feedback", content: "Prefers PostgreSQL." })
    const { coordinator, model, conversations, state, store } = setup({ replies: reply })
    seedMemory(store, { fileName: "existing", name: "Existing", description: "already known" })
    conversations.set("ses_1", conversation("ses_1", 2))

    await idle(coordinator, "ses_1")

    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]?.task).toBe("extract")
    expect(model.calls[0]?.timeoutMs).toBe(200)
    const prompt = promptOf(model.calls[0])
    expect(prompt).toContain(EXTRACT_EXISTING_MEMORIES_HEADING)
    expect(prompt).toContain("existing.md")
    expect(prompt).toContain("### User\nI prefer PostgreSQL for everything, turn 1.")
    expect(prompt).toContain("### Assistant\nNoted, turn 2.")
    expect(prompt).toContain("_[tool grep: match]_")

    expect(store.read("feedback_postgres")?.body).toBe("Prefers PostgreSQL.")
    expect(store.readIndex()).toContain("feedback_postgres.md")
    expect(state.getSession("ses_1")).toMatchObject({ lastExtractedMessageID: "ses_1_a2", failures: 0 })
    expect(state.read().autodream.sessionsSince).toEqual(["ses_1"])
  })

  test("a second idle without new user messages makes no call; a new turn extracts only the delta", async () => {
    const { coordinator, model, conversations, state } = setup()
    conversations.set("ses_2", conversation("ses_2", 1))
    await idle(coordinator, "ses_2")
    expect(model.calls).toHaveLength(1)

    await idle(coordinator, "ses_2")
    expect(model.calls).toHaveLength(1)

    conversations.set("ses_2", conversation("ses_2", 2))
    await idle(coordinator, "ses_2")
    expect(model.calls).toHaveLength(2)
    expect(promptOf(model.calls[1])).toContain("turn 2")
    expect(promptOf(model.calls[1])).not.toContain("turn 1")
    expect(state.getSession("ses_2")?.lastExtractedMessageID).toBe("ses_2_a2")
  })

  test("a failing call keeps the watermark and counts failures up to the cap, then moves on", async () => {
    const { coordinator, model, conversations, state, entries, now } = setup({
      replies: new Error("gateway unavailable"),
    })
    conversations.set("ses_3", conversation("ses_3", 1))

    for (let attempt = 1; attempt < MAX_EXTRACTION_FAILURES; attempt++) {
      await idle(coordinator, "ses_3")
      expect(state.getSession("ses_3")).toMatchObject({ updatedAt: 0, failures: attempt })
      expect(state.getSession("ses_3")?.attemptedAt).toBe(now())
    }
    expect(entries.filter((e) => e.level === "error")).toHaveLength(MAX_EXTRACTION_FAILURES - 1)
    expect(entries[0]).toEqual({
      level: "error",
      message: "Memory extraction failed",
      extra: { error: "gateway unavailable", sessionID: "ses_3", failures: 1 },
    })

    await idle(coordinator, "ses_3")
    expect(state.getSession("ses_3")).toMatchObject({ lastExtractedMessageID: "ses_3_a1", failures: 0 })
    expect(model.calls).toHaveLength(MAX_EXTRACTION_FAILURES)
  })

  test("a reply that is not JSON counts as a failure, not as an empty extraction", async () => {
    const { coordinator, conversations, state, entries } = setup({ replies: "I found nothing worth saving." })
    conversations.set("ses_json", conversation("ses_json", 1))
    await idle(coordinator, "ses_json")
    expect(state.getSession("ses_json")).toMatchObject({ failures: 1 })
    expect(entries[0]?.extra).toMatchObject({ error: "the model reply did not contain a JSON object" })
  })

  test("never overwrites an existing memory", async () => {
    const reply = memoriesReply({ fileName: "existing", content: "clobbered" }, { fileName: "fresh" })
    const { coordinator, conversations, store, entries } = setup({ replies: reply })
    seedMemory(store, { fileName: "existing", content: "original" })
    conversations.set("ses_o", conversation("ses_o", 1))
    await idle(coordinator, "ses_o")
    expect(store.read("existing")?.body).toBe("original")
    expect(store.read("fresh")).not.toBeNull()
    expect(entries.find((e) => e.message === "Memory extraction finished")?.extra).toMatchObject({
      saved: ["fresh.md"],
      skipped: ["existing"],
    })
  })

  test("skips the model but advances the watermark when the main agent already saved memory", async () => {
    const { coordinator, model, conversations, state } = setup()
    conversations.set("ses_4", conversation("ses_4", 1))
    coordinator.recordSave("ses_4")

    await idle(coordinator, "ses_4")
    expect(model.calls).toHaveLength(0)
    expect(state.getSession("ses_4")?.lastExtractedMessageID).toBe("ses_4_a1")
    expect(state.read().autodream.sessionsSince).toEqual(["ses_4"])

    conversations.set("ses_4", conversation("ses_4", 2))
    await idle(coordinator, "ses_4")
    expect(model.calls).toHaveLength(1)
  })

  test("advances the watermark without a model call for trivial conversations", async () => {
    const { coordinator, model, conversations, state } = setup()
    conversations.set("ses_5", [sessionUser("hi", 1, "ses_5_u1")])
    await idle(coordinator, "ses_5")
    expect(model.calls).toHaveLength(0)
    expect(state.getSession("ses_5")?.lastExtractedMessageID).toBe("ses_5_u1")
  })

  test("does nothing when extraction is disabled or after dispose", async () => {
    const disabled = setup({ config: { extract: { enabled: false, debounceMs: 0 } } })
    disabled.conversations.set("ses_7", conversation("ses_7", 1))
    await idle(disabled.coordinator, "ses_7")
    expect(disabled.model.calls).toHaveLength(0)

    const live = setup()
    live.conversations.set("ses_8", conversation("ses_8", 1))
    live.coordinator.dispose()
    await idle(live.coordinator, "ses_8")
    expect(live.model.calls).toHaveLength(0)
  })

  test("does nothing without a model generator or session reader", async () => {
    const store = makeStore()
    const config = makeConfig({ extract: { debounceMs: 0 } }, store.claudeConfigDir)
    const bare = new ExtractionCoordinator(deps({ store, config }))
    expect(bare.enabled).toBe(false)
    bare.onEvent(idleEvent("x"))
    await bare.idle()
  })

  test("session.deleted cancels a pending debounce", async () => {
    const { coordinator, model, conversations } = setup({ config: { extract: { debounceMs: 20 } } })
    conversations.set("ses_9", conversation("ses_9", 1))
    coordinator.onEvent(idleEvent("ses_9"))
    coordinator.onEvent({ type: "session.deleted", data: { sessionID: "ses_9" } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await coordinator.idle()
    expect(model.calls).toHaveLength(0)
  })

  test("failures are logged through the plugin log, never stderr", async () => {
    const { coordinator, conversations } = setup({ replies: new Error("boom") })
    conversations.set("ses_10", conversation("ses_10", 1))
    const originalError = console.error
    const stderr: unknown[] = []
    console.error = (...args: unknown[]) => void stderr.push(args)
    try {
      await idle(coordinator, "ses_10")
    } finally {
      console.error = originalError
    }
    expect(stderr).toEqual([])
  })
})

describe("ExtractionCoordinator event routing", () => {
  test("idle, succeeded, failed and interrupted executions all schedule an extraction", async () => {
    for (const type of [
      "session.idle",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]) {
      const { coordinator, model, conversations } = setup()
      conversations.set("ses_e", conversation("ses_e", 1))
      coordinator.onEvent({ type, data: { sessionID: "ses_e" } })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await coordinator.idle()
      expect(model.calls).toHaveLength(1)
    }
  })

  test("events without a session id and unrelated events are ignored", async () => {
    const { coordinator, model } = setup()
    coordinator.onEvent({ type: "session.idle" })
    coordinator.onEvent({ type: "session.text.delta", data: { sessionID: "s" } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await coordinator.idle()
    expect(model.calls).toHaveLength(0)
  })

  test("only top-level sessions of this plugin's directory are extracted", async () => {
    const { coordinator, model, conversations, sessions, store } = setup()
    for (const id of ["foreign", "child", "mine", "unknown"]) conversations.set(id, conversation(id, 1))
    sessions.infos.set("foreign", { id: "foreign", location: { directory: "/somewhere/else" } })
    sessions.infos.set("child", { id: "child", parentID: "mine", location: { directory: store.memoryRoot } })
    sessions.messages.delete("unknown")

    for (const id of ["foreign", "child", "unknown"]) await idle(coordinator, id)
    expect(model.calls).toHaveLength(0)
    expect(sessions.contextCalls).toEqual([])

    await idle(coordinator, "mine")
    expect(model.calls).toHaveLength(1)
  })

  test("the ownership answer is cached per session", async () => {
    const { coordinator, conversations, sessions } = setup()
    conversations.set("ses_c", conversation("ses_c", 1))
    let gets = 0
    const get = sessions.get
    sessions.get = async (id) => {
      gets += 1
      return get(id)
    }
    await idle(coordinator, "ses_c")
    conversations.set("ses_c", conversation("ses_c", 2))
    await idle(coordinator, "ses_c")
    expect(gets).toBe(1)
  })
})

describe("ExtractionCoordinator cross-process lock (#30)", () => {
  test("skips the call and leaves the watermark alone while another live process holds the lock", async () => {
    const { coordinator, model, conversations, state, entries } = setup()
    conversations.set("ses_lock", conversation("ses_lock", 1))
    const other = new MaintenanceLock(state.lockPath, Date.now, 99999, () => true)
    expect(other.tryAcquire()).toBe(true)

    await idle(coordinator, "ses_lock")
    expect(model.calls).toHaveLength(0)
    expect(state.getSession("ses_lock")).toBeUndefined()
    expect(entries.some((e) => e.level === "info" && String(e.message).includes("maintenance lock"))).toBe(true)

    other.release()
    await idle(coordinator, "ses_lock")
    expect(model.calls).toHaveLength(1)
    expect(state.getSession("ses_lock")?.lastExtractedMessageID).toBe("ses_lock_a1")
    // released after the run so the next process (or auto-dream) can take it
    expect(new MaintenanceLock(state.lockPath, Date.now, 4242, () => true).tryAcquire()).toBe(true)
  })

  test("state updates are read from disk, so a change written by another process is not overwritten", async () => {
    const { coordinator, conversations, state } = setup()
    conversations.set("ses_a", conversation("ses_a", 1))
    // Another process recorded its own session between our reads.
    new ExtractionStateStore(state.stateDir).update((data) => {
      data.sessions.other_process = { lastExtractedMessageID: "x", updatedAt: Date.now(), failures: 0 }
    })
    await idle(coordinator, "ses_a")
    expect(Object.keys(state.read().sessions).sort()).toEqual(["other_process", "ses_a"])
  })
})

describe("pure helpers", () => {
  const msgs = conversation("s", 2)

  test("sliceNewMessages honours the watermark and falls back to timestamps", () => {
    expect(sliceNewMessages(msgs, undefined)).toHaveLength(4)
    expect(
      sliceNewMessages(msgs, { lastExtractedMessageID: "s_a1", updatedAt: 0, failures: 0 }).map((m) => m.id),
    ).toEqual(["s_u2", "s_a2"])
    expect(sliceNewMessages(msgs, { lastExtractedMessageID: "s_a2", updatedAt: 0, failures: 0 })).toEqual([])
    expect(
      sliceNewMessages(msgs, { lastExtractedMessageID: "deleted", updatedAt: 15, failures: 0 }).map((m) => m.id),
    ).toEqual(["s_u2", "s_a2"])
  })

  test("hasExtractableUserMessage ignores empty text and non-user messages", () => {
    expect(hasExtractableUserMessage([sessionUser("real")])).toBe(true)
    expect(hasExtractableUserMessage([sessionUser("   "), sessionAssistant("x")])).toBe(false)
    expect(hasExtractableUserMessage([{ id: "s", type: "synthetic", text: "auto" }])).toBe(false)
  })

  test("buildConversationForExtraction keeps the tail when truncating and skips unfinished tools", () => {
    const text = buildConversationForExtraction(msgs, 60)
    expect(text.startsWith("…[older turns truncated]")).toBe(true)
    expect(text.length).toBeLessThan(120)
    expect(buildConversationForExtraction([{ id: "s", type: "synthetic", text: "auto" }], 1000)).toBe("")
    const running = sessionAssistant([toolPart("bash", "out", "running"), textPart("answer")])
    expect(buildConversationForExtraction([running], 1000)).toBe("### Assistant\nanswer")
  })

  test("long tool output is cut to 300 characters", () => {
    const long = sessionAssistant([toolPart("read", "x".repeat(500))])
    const text = buildConversationForExtraction([long], 10_000)
    expect(text).toContain(`${"x".repeat(300)}…`)
    expect(text).not.toContain("x".repeat(301))
  })
})

describe("ExtractionCoordinator watermark transactions (review F1)", () => {
  test("a snapshot taken before the lock never rolls the watermark back over another process's progress", async () => {
    const { coordinator, model, conversations, sessions, state } = setup()
    conversations.set("ses_r", turn("ses_r", 1, "Remember PostgreSQL for this project."))

    // Between our context read and our lock acquisition, "another process" extracts through a2.
    let injected = false
    const read = sessions.context
    sessions.context = async (id) => {
      const result = await read(id)
      if (!injected) {
        injected = true
        new ExtractionStateStore(state.stateDir).update((data) => {
          data.sessions.ses_r = {
            lastExtractedMessageID: "ses_r_a2",
            lastMessageAt: 25,
            updatedAt: Date.now(),
            failures: 0,
          }
        })
      }
      return result
    }

    await idle(coordinator, "ses_r")
    expect(model.calls).toHaveLength(0)
    expect(state.getSession("ses_r")?.lastExtractedMessageID).toBe("ses_r_a2")
  })

  test("the main-agent short-circuit also respects a newer watermark", async () => {
    const { coordinator, conversations, state } = setup()
    conversations.set("ses_s", turn("ses_s", 1, "Remember PostgreSQL for this project."))
    state.update((data) => {
      data.sessions.ses_s = { lastExtractedMessageID: "gone", lastMessageAt: 999, updatedAt: Date.now(), failures: 0 }
    })
    coordinator.recordSave("ses_s")
    await idle(coordinator, "ses_s")
    expect(state.getSession("ses_s")?.lastExtractedMessageID).toBe("gone")
  })

  test("the watermark is committed before the maintenance lock is released", async () => {
    const store = makeStore()
    const config = makeConfig(
      { extract: { debounceMs: 0, timeoutMs: 200 }, autodream: { enabled: false } },
      store.claudeConfigDir,
    )
    const sessions = makeSessions(store.memoryRoot, {
      ses_c: turn("ses_c", 1, "Remember PostgreSQL for this project."),
    })
    const state = new ExtractionStateStore(store.stateDir)
    let watermarkAtRelease: string | undefined = "not-released"
    class ObservingLock extends MaintenanceLock {
      override release(): void {
        watermarkAtRelease = state.getSession("ses_c")?.lastExtractedMessageID
        super.release()
      }
    }
    const coordinator = new ExtractionCoordinator({
      ...deps({ store, config, generate: makeGenerate('{"memories": []}').generate, sessions }),
      state,
      lock: new ObservingLock(state.lockPath, Date.now, 4242, () => true),
    })
    await idle(coordinator, "ses_c")
    expect(watermarkAtRelease).toBe("ses_c_a1")
    expect(state.getSession("ses_c")?.lastMessageAt).toBe(15)
  })

  test("a turn that completes while the model call runs is extracted on the next idle", async () => {
    const gate = deferred<string>()
    const { coordinator, model, conversations, state } = setup({ replies: () => gate.promise })
    conversations.set("ses_f", turn("ses_f", 1, "Remember our PostgreSQL conventions."))
    coordinator.onEvent(idleEvent("ses_f"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    // A new turn arrives (and finishes) while the first call is still running.
    conversations.set("ses_f", [
      ...(conversations.get("ses_f") ?? []),
      ...turn("ses_f", 2, "Deployments must wait until Friday."),
    ])
    gate.resolve('{"memories": []}')
    await coordinator.idle()
    expect(state.getSession("ses_f")?.lastExtractedMessageID).toBe("ses_f_a1")
    expect(state.getSession("ses_f")?.lastMessageAt).toBe(15)

    await idle(coordinator, "ses_f")
    expect(model.calls).toHaveLength(2)
    const second = promptOf(model.calls[1])
    expect(second).toContain("Deployments must wait until Friday.")
    expect(second).not.toContain("PostgreSQL conventions")
    expect(state.getSession("ses_f")?.lastExtractedMessageID).toBe("ses_f_a2")
  })

  test("the fallback slice uses the watermark message time, not the extraction's finish time", () => {
    const messages = turn("ses_x", 2, "second")
    const state = { lastExtractedMessageID: "missing", lastMessageAt: 15, updatedAt: 99_999, failures: 0 }
    expect(sliceNewMessages(messages, state).map((m) => m.id)).toEqual(["ses_x_u2", "ses_x_a2"])
  })
})

describe("ExtractionCoordinator busy sessions (review F4)", () => {
  test("a started execution cancels the pending debounce; the next idle extracts both turns at once", async () => {
    const { coordinator, model, conversations, state, config } = setup()
    config.extract.debounceMs = 20
    conversations.set("ses_b", turn("ses_b", 1, "Remember our PostgreSQL conventions."))
    coordinator.onEvent(idleEvent("ses_b"))
    // New turn starts before the debounce fires: assistant still streaming (no `completed`).
    conversations.set("ses_b", [
      ...(conversations.get("ses_b") ?? []),
      sessionUser("Please diagnose the deployment failure.", 20, "ses_b_u2"),
      { ...sessionAssistant("Still investigating...", { id: "ses_b_a2" }), time: { created: 25 } },
    ])
    coordinator.onEvent({ type: "session.execution.started", data: { sessionID: "ses_b" } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await coordinator.idle()
    expect(model.calls).toHaveLength(0)
    expect(state.getSession("ses_b")).toBeUndefined()

    // The answer completes and the session goes idle.
    conversations.set("ses_b", [
      ...(conversations.get("ses_b") ?? []).slice(0, 3),
      {
        ...sessionAssistant("Final finding: the deploy must use port 8088.", { id: "ses_b_a2" }),
        time: { created: 25, completed: 30 },
      },
    ])
    await idle(coordinator, "ses_b")
    await new Promise((resolve) => setTimeout(resolve, 30))
    await coordinator.idle()
    expect(model.calls).toHaveLength(1)
    const prompt = promptOf(model.calls[0])
    expect(prompt).toContain("PostgreSQL conventions")
    expect(prompt).toContain("port 8088")
    expect(state.getSession("ses_b")?.lastExtractedMessageID).toBe("ses_b_a2")
  })

  test("an assistant message still being generated is never extracted or used as the watermark", async () => {
    const { coordinator, model, conversations, state } = setup()
    conversations.set("ses_i", [
      ...turn("ses_i", 1, "Remember our PostgreSQL conventions."),
      sessionUser("Now diagnose the failure.", 20, "ses_i_u2"),
      { ...sessionAssistant("Partial answer so far", { id: "ses_i_a2" }), time: { created: 25 } },
    ])
    await idle(coordinator, "ses_i")
    expect(promptOf(model.calls[0])).not.toContain("Partial answer so far")
    expect(state.getSession("ses_i")?.lastExtractedMessageID).toBe("ses_i_u2")
  })

  test("trimIncompleteTail only drops the trailing streaming run", () => {
    const done = { ...sessionAssistant("done"), time: { created: 1, completed: 2 } }
    const streaming = { ...sessionAssistant("..."), time: { created: 3 } }
    const user = sessionUser("q")
    expect(trimIncompleteTail([user, done, streaming]).map((m) => m.id)).toEqual([user.id, done.id])
    expect(trimIncompleteTail([streaming, user])).toHaveLength(2)
    expect(trimIncompleteTail([])).toEqual([])
  })

  test("a job dequeued while its session is busy is skipped and retried on the next idle", async () => {
    const { coordinator, model, conversations } = setup()
    conversations.set("ses_q", turn("ses_q", 1, "Remember our PostgreSQL conventions."))
    coordinator.onEvent(idleEvent("ses_q"))
    coordinator.onEvent({ type: "session.execution.started", data: { sessionID: "ses_q" } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await coordinator.idle()
    expect(model.calls).toHaveLength(0)
    await idle(coordinator, "ses_q")
    expect(model.calls).toHaveLength(1)
  })
})

describe("ExtractionCoordinator.start (v1 migration)", () => {
  test("carries the v1 auto-dream timestamp over once", () => {
    const { coordinator, state } = setup()
    coordinator.start()
    expect(state.read().autodream.lastConsolidatedAt).toBe(0)
  })
})
