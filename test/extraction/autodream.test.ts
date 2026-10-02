import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  AutoDream,
  backupMemoryDir,
  DREAM_BACKUPS_KEPT,
  MAX_AUTODREAM_PROMPT_CHARS,
  shouldRunAutodream,
} from "../../src/extraction/autodream.js"
import { MaintenanceLock } from "../../src/extraction/lock.js"
import { AUTODREAM_MEMORIES_HEADING, AUTODREAM_PROMPT } from "../../src/extraction/prompts.js"
import { ExtractionStateStore } from "../../src/extraction/state.js"
import {
  cleanupTempDirs,
  collectingLog,
  deps,
  makeConfig,
  makeGenerate,
  makeStore,
  type Reply,
  seedMemory,
} from "../helpers/index.js"

afterEach(cleanupTempDirs)

const HOUR = 60 * 60 * 1000

describe("shouldRunAutodream", () => {
  const gate = { minHours: 24, minSessions: 5 }
  const now = 100 * HOUR

  test("requires both the time gate and the session gate", () => {
    expect(
      shouldRunAutodream({ lastConsolidatedAt: now - 25 * HOUR, sessionsSince: ["a", "b", "c", "d", "e"] }, gate, now),
    ).toBe(true)
    expect(
      shouldRunAutodream({ lastConsolidatedAt: now - 23 * HOUR, sessionsSince: ["a", "b", "c", "d", "e"] }, gate, now),
    ).toBe(false)
    expect(
      shouldRunAutodream({ lastConsolidatedAt: now - 25 * HOUR, sessionsSince: ["a", "b", "c", "d"] }, gate, now),
    ).toBe(false)
    expect(shouldRunAutodream({ lastConsolidatedAt: 0, sessionsSince: ["a", "b", "c", "d", "e"] }, gate, now)).toBe(
      true,
    )
  })
})

const NOTHING = '{"save": [], "delete": []}'

describe("AutoDream.maybeRun", () => {
  function setup(
    options: {
      lastConsolidatedAt?: number
      sessions?: string[]
      enabled?: boolean
      now?: number
      replies?: Reply | Reply[]
    } = {},
  ) {
    const now = options.now ?? 100 * HOUR
    const store = makeStore()
    seedMemory(store, { fileName: "a", content: "alpha body" })
    seedMemory(store, { fileName: "b", content: "beta body" })
    seedMemory(store, { fileName: "c", content: "gamma body" })
    const config = makeConfig(
      { autodream: { enabled: options.enabled ?? true, minHours: 24, minSessions: 2 } },
      store.claudeConfigDir,
    )
    const state = new ExtractionStateStore(store.stateDir, () => now)
    state.update((data) => {
      data.autodream.lastConsolidatedAt = options.lastConsolidatedAt ?? 0
      data.autodream.sessionsSince = options.sessions ?? ["a", "b"]
    })
    const model = makeGenerate(options.replies ?? NOTHING)
    const { log, entries } = collectingLog()
    const base = deps({ store, config, log, now: () => now })
    // The lock's liveness probe is injected so the test does not depend on which PIDs exist on the runner.
    const lock = new MaintenanceLock(
      state.lockPath,
      () => now,
      4242,
      () => true,
    )
    const dream = new AutoDream({ ...base, generate: model.generate, state, lock })
    return { dream, state, model, entries, now, store }
  }

  test("sends every memory in one call, applies the plan and resets the gate", async () => {
    const plan = JSON.stringify({
      save: [{ file_name: "a", name: "A", description: "merged", type: "user", content: "alpha and beta merged" }],
      delete: ["b.md"],
    })
    const { dream, state, model, now, store } = setup({ replies: plan })
    expect(await dream.maybeRun()).toBe(true)

    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]?.task).toBe("autodream")
    expect(model.calls[0]?.timeoutMs).toBe(300_000)
    const prompt = model.calls[0]?.prompt ?? ""
    expect(prompt).toContain(AUTODREAM_PROMPT)
    expect(prompt).toContain(AUTODREAM_MEMORIES_HEADING)
    for (const body of ["alpha body", "beta body", "gamma body"]) expect(prompt).toContain(body)
    expect(prompt).toContain("### a.md")

    expect(store.read("a")?.body).toBe("alpha and beta merged")
    expect(store.read("b")).toBeNull()
    expect(store.read("c")?.body).toBe("gamma body")
    expect(state.read().autodream).toEqual({ lastConsolidatedAt: now, sessionsSince: [] })
    expect(existsSync(join(store.stateDir, "maintenance.lock"))).toBe(false)
  })

  test("backs the memory directory up before applying a plan", async () => {
    const plan = JSON.stringify({ save: [], delete: ["b"] })
    const { dream, store } = setup({ replies: plan })
    await dream.maybeRun()
    const backups = readdirSync(join(store.stateDir, "dream-backups"))
    expect(backups).toHaveLength(1)
    const backed = join(store.stateDir, "dream-backups", backups[0] ?? "", "b.md")
    expect(existsSync(backed)).toBe(true)
  })

  test("does nothing while the gate is closed or when disabled", async () => {
    const closed = setup({ sessions: ["a"] })
    expect(await closed.dream.maybeRun()).toBe(false)
    expect(closed.model.calls).toHaveLength(0)

    const recent = setup({ lastConsolidatedAt: 90 * HOUR })
    expect(await recent.dream.maybeRun()).toBe(false)

    const disabled = setup({ enabled: false })
    expect(await disabled.dream.maybeRun()).toBe(false)
  })

  test("keeps the gate unchanged when the call fails or the reply is unusable", async () => {
    const failing = setup({ replies: new Error("model unavailable") })
    expect(await failing.dream.maybeRun()).toBe(false)
    expect(failing.state.read().autodream).toEqual({ lastConsolidatedAt: 0, sessionsSince: ["a", "b"] })
    expect(failing.entries.some((e) => e.level === "error" && String(e.message).includes("Auto-dream"))).toBe(true)

    const garbage = setup({ replies: "all good, nothing to do" })
    expect(await garbage.dream.maybeRun()).toBe(false)
    expect(garbage.state.read().autodream.sessionsSince).toEqual(["a", "b"])
    expect(garbage.store.read("a")?.body).toBe("alpha body")
  })

  test("skips an empty memory set and a set too large for one prompt", async () => {
    const empty = setup()
    for (const name of ["a", "b", "c"]) empty.store.delete(name)
    expect(await empty.dream.maybeRun()).toBe(false)
    expect(empty.model.calls).toHaveLength(0)

    const large = setup()
    const chunk = Math.floor(MAX_AUTODREAM_PROMPT_CHARS / 4) + 1_000
    for (let i = 0; i < 4; i++) seedMemory(large.store, { fileName: `huge${i}`, content: "x".repeat(chunk) })
    expect(await large.dream.maybeRun()).toBe(false)
    expect(large.model.calls).toHaveLength(0)
    expect(large.entries.some((e) => e.level === "warn" && String(e.message).includes("too large"))).toBe(true)
  })

  test("skips when another live process holds the lock", async () => {
    const { dream, state, model, entries } = setup()
    const lock = new MaintenanceLock(
      state.lockPath,
      () => Date.now(),
      99999,
      () => true,
    )
    expect(lock.tryAcquire()).toBe(true)
    expect(await dream.maybeRun()).toBe(false)
    expect(model.calls).toHaveLength(0)
    expect(entries.some((e) => String(e.message).includes("lock"))).toBe(true)
  })
})

describe("backupMemoryDir", () => {
  test("copies the memory directory and keeps only the newest copies", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "a" })
    for (let i = 0; i < DREAM_BACKUPS_KEPT + 2; i++) backupMemoryDir(store, 1_000_000 + i * 1000)
    const kept = readdirSync(join(store.stateDir, "dream-backups"))
    expect(kept).toHaveLength(DREAM_BACKUPS_KEPT)
    expect(kept.sort()).toEqual(kept)
    expect(existsSync(join(store.stateDir, "dream-backups", kept[0] ?? "", "a.md"))).toBe(true)
  })
})
