import { afterEach, describe, expect, test } from "bun:test"
import { RecallCoordinator, SESSION_STATE_TTL_MS } from "../../src/recall/RecallCoordinator.js"
import {
  cleanupTempDirs,
  contextMessage,
  deferred,
  deps,
  makeConfig,
  makeGenerate,
  makeStore,
  type Reply,
  seedMemory,
  selectionReply,
  sleep,
  userContext,
} from "../helpers/index.js"

afterEach(cleanupTempDirs)

function setup(options: { replies?: Reply | Reply[]; waitMs?: number; enabled?: boolean; now?: () => number } = {}) {
  const store = makeStore()
  seedMemory(store, {
    fileName: "testing_pref",
    name: "Testing Preference",
    description: "Database test guidance",
    type: "feedback",
    content: "Use real databases.",
  })
  seedMemory(store, {
    fileName: "grep_ref",
    name: "Grep Tool API",
    description: "Usage reference for grep",
    type: "reference",
    content: "grep -r",
  })
  const model = makeGenerate(options.replies ?? selectionReply("testing_pref.md"))
  const config = makeConfig(
    { recall: { waitMs: options.waitMs ?? 1_500, enabled: options.enabled ?? true } },
    store.claudeConfigDir,
  )
  const recall = new RecallCoordinator(deps({ store, config, generate: model.generate, now: options.now }))
  return { store, recall, model }
}

const names = (outcome: { recalled: Array<{ name: string }> }) => outcome.recalled.map((m) => m.name)

describe("RecallCoordinator prefetch", () => {
  test("the first call of a turn receives the recalled memories", async () => {
    const { recall, model } = setup()
    const outcome = await recall.onContext("ses_1", [userContext("How should we test database changes?", "m1")])
    expect(outcome.ignored).toBe(false)
    expect(names(outcome)).toEqual(["Testing Preference"])
    expect(outcome.recalled[0]?.content).toBe("Use real databases.")
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]?.task).toBe("recall")
  })

  test("later calls of the same turn reuse the result without another model call", async () => {
    const { recall, model } = setup()
    const first = userContext("How should we test database changes?", "m1")
    const a = await recall.onContext("ses_1", [first])
    const b = await recall.onContext("ses_1", [first, contextMessage("assistant", "calling a tool")])
    expect(names(b)).toEqual(names(a))
    expect(model.calls).toHaveLength(1)
  })

  test("a new user message starts a new selection", async () => {
    const { recall, model } = setup({ replies: [selectionReply("testing_pref.md"), selectionReply("grep_ref.md")] })
    const first = userContext("How should we test database changes?", "m1")
    expect(names(await recall.onContext("ses_4", [first]))).toEqual(["Testing Preference"])
    expect(names(await recall.onContext("ses_4", [first, userContext("How do I use grep?", "m2")]))).toEqual([
      "Grep Tool API",
    ])
    expect(model.calls).toHaveLength(2)
  })

  test("a slow selector yields nothing on the first call and the result on a later call", async () => {
    const gate = deferred<string>()
    const { recall, model } = setup({ waitMs: 30, replies: () => gate.promise })
    const messages = [userContext("How should we test database changes?", "m1")]
    expect((await recall.onContext("ses_2", messages)).recalled).toEqual([])

    gate.resolve(selectionReply("testing_pref.md"))
    await sleep(5)
    expect(names(await recall.onContext("ses_2", messages))).toEqual(["Testing Preference"])
    expect(model.calls).toHaveLength(1)
  })

  test("waitMs = 0 only injects an already settled selection", async () => {
    const gate = deferred<string>()
    const { recall } = setup({ waitMs: 0, replies: () => gate.promise })
    const messages = [userContext("How should we test database changes?", "m1")]
    expect((await recall.onContext("ses_3", messages)).recalled).toEqual([])
    gate.resolve(selectionReply("testing_pref.md"))
    await sleep(5)
    expect(names(await recall.onContext("ses_3", messages))).toEqual(["Testing Preference"])
  })

  test("a failing or unparsable selector recalls nothing and never throws", async () => {
    const failing = setup({ replies: new Error("model down") })
    expect(
      (await failing.recall.onContext("s", [userContext("How should we test database changes?", "m1")])).recalled,
    ).toEqual([])
    const garbage = setup({ replies: "no json" })
    expect(
      (await garbage.recall.onContext("s", [userContext("How should we test database changes?", "m1")])).recalled,
    ).toEqual([])
  })

  test("does not call the model for trivial queries, an empty store or when recall is disabled", async () => {
    const trivial = setup()
    expect((await trivial.recall.onContext("s", [userContext("hi", "m1")])).recalled).toEqual([])
    expect(trivial.model.calls).toHaveLength(0)

    const cjk = setup()
    expect(names(await cjk.recall.onContext("s", [userContext("数据库测试怎么做", "m1")]))).toEqual([
      "Testing Preference",
    ])

    const disabled = setup({ enabled: false })
    expect(
      (await disabled.recall.onContext("s", [userContext("How should we test database changes?", "m1")])).recalled,
    ).toEqual([])
    expect(disabled.model.calls).toHaveLength(0)

    const empty = makeStore()
    const model = makeGenerate()
    const recall = new RecallCoordinator(deps({ store: empty, generate: model.generate }))
    await recall.onContext("s", [userContext("How should we test database changes?", "m1")])
    expect(model.calls).toHaveLength(0)
  })

  test("without a generator nothing is recalled", async () => {
    const recall = new RecallCoordinator(deps({ store: makeStore() }))
    expect((await recall.onContext("s", [userContext("How should we test database changes?", "m1")])).recalled).toEqual(
      [],
    )
  })
})

describe("RecallCoordinator ignore-memory", () => {
  test("ignore persists for the session until the user asks for memory again", async () => {
    const { recall, model } = setup()
    const ignoring = userContext("Ignore memory and answer from fresh context only.", "m1")
    const first = await recall.onContext("ses_9", [ignoring])
    expect(first).toEqual({ ignored: true, recalled: [] })
    expect(recall.isIgnored("ses_9")).toBe(true)
    expect(model.calls).toHaveLength(0)

    const next = await recall.onContext("ses_9", [ignoring, userContext("How should we test database changes?", "m2")])
    expect(next.ignored).toBe(true)
    expect(model.calls).toHaveLength(0)

    const resumed = await recall.onContext("ses_9", [ignoring, userContext("ok, use memory again please", "m3")])
    expect(resumed.ignored).toBe(false)
    expect(recall.isIgnored("ses_9")).toBe(false)
  })
})

describe("RecallCoordinator lifecycle", () => {
  test("session.deleted drops the session state", async () => {
    const { recall } = setup()
    await recall.onContext("ses_10", [userContext("Ignore memory.", "m1")])
    expect(recall.isIgnored("ses_10")).toBe(true)
    recall.onSessionDeleted("ses_10")
    expect(recall.isIgnored("ses_10")).toBe(false)
    expect(recall.trackedSessions).toBe(0)
  })

  test("stale turn caches are evicted after the TTL, but an ignored session keeps its instruction", async () => {
    let now = 1_000_000
    const { recall } = setup({ now: () => now })
    await recall.onContext("ses_plain", [userContext("hello there", "m1")])
    await recall.onContext("ses_ignored", [userContext("Ignore memory.", "m1")])
    expect(recall.trackedSessions).toBe(2)
    now += SESSION_STATE_TTL_MS + 1
    await recall.onContext("ses_new", [userContext("hello there", "m1")])
    // the plain session is gone; the ignored one is kept because the user asked for it
    expect(recall.trackedSessions).toBe(2)
    expect(recall.isIgnored("ses_ignored")).toBe(true)
    expect(recall.isIgnored("ses_plain")).toBe(false)
  })

  test("an ignore instruction keeps applying after the TTL without a resume", async () => {
    let now = 1_000_000
    const { recall, model } = setup({ now: () => now })
    const first = userContext("Ignore memory for this session.", "m1")
    await recall.onContext("ses_ttl", [first])
    now += SESSION_STATE_TTL_MS + 1
    const outcome = await recall.onContext("ses_ttl", [first, userContext("Continue with the deployment work.", "m2")])
    expect(outcome.ignored).toBe(true)
    expect(model.calls).toHaveLength(0)
  })

  test("a session first seen mid-conversation derives the ignore state from its history", async () => {
    const { recall } = setup()
    // e.g. after a process restart: the coordinator never saw the earlier "ignore memory" turn
    await recall.onContext("ses_hist", [
      userContext("Please ignore memory from now on.", "m1"),
      userContext("What did we decide about the database?", "m2"),
    ])
    expect(recall.isIgnored("ses_hist")).toBe(true)

    const resumed = setup().recall
    await resumed.onContext("ses_res", [
      userContext("Please ignore memory from now on.", "m1"),
      userContext("OK, use memory again.", "m2"),
      userContext("What did we decide about the database?", "m3"),
    ])
    expect(resumed.isIgnored("ses_res")).toBe(false)
  })
})
