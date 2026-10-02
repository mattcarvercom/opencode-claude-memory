// Auto-dream: periodic memory consolidation, gated on time since the last pass and on the number of
// sessions extracted since then. Port of the v1 bash wrapper's gate and lock semantics.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { MemoryConfig } from "../config.js"
import type { TaskGenerator } from "../llm.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { getErrorMessage, type Logger } from "../util/log.js"
import { applyDream, parseDreamReply } from "./apply.js"
import { MaintenanceLock } from "./lock.js"
import { buildAutodreamPrompt } from "./prompts.js"
import type { AutodreamState, ExtractionStateStore } from "./state.js"

// All memories are sent in one prompt; a store larger than this is skipped rather than truncated.
export const MAX_AUTODREAM_PROMPT_CHARS = 150_000

export const DREAM_BACKUPS_KEPT = 3

// An unattended model rewrites the memory set, so the whole directory is copied first (outside the
// Claude Code project directory) and only the newest few copies are kept.
export function backupMemoryDir(store: Pick<MemoryStore, "memoryDir" | "stateDir">, now: number): string {
  const root = join(store.stateDir, "dream-backups")
  const target = join(root, new Date(now).toISOString().replace(/[:.]/g, "-"))
  mkdirSync(root, { recursive: true })
  cpSync(store.memoryDir, target, { recursive: true, preserveTimestamps: true })
  const old = readdirSync(root).sort().slice(0, -DREAM_BACKUPS_KEPT)
  for (const name of old) rmSync(join(root, name), { recursive: true, force: true })
  return target
}

export type AutodreamGate = Pick<MemoryConfig["autodream"], "minHours" | "minSessions">

export function shouldRunAutodream(state: AutodreamState, gate: AutodreamGate, now: number): boolean {
  const hoursSince = (now - state.lastConsolidatedAt) / (60 * 60 * 1000)
  if (hoursSince < gate.minHours) return false
  return state.sessionsSince.length >= gate.minSessions
}

export type AutoDreamDeps = {
  store: MemoryStore
  config: MemoryConfig
  generate: TaskGenerator
  state: ExtractionStateStore
  log: Logger
  now?: () => number
  lock?: MaintenanceLock
}

export function formatMemoriesForDream(store: MemoryStore): { text: string; count: number } {
  const entries = store.list({ sort: "name" })
  const text = entries
    .map(
      (entry) =>
        `### ${entry.filename}\nname: ${entry.name}\ndescription: ${entry.description}\ntype: ${entry.type}\n\n${entry.body.trim()}`,
    )
    .join("\n\n")
  return { text, count: entries.length }
}

export class AutoDream {
  private readonly now: () => number
  private readonly lock: MaintenanceLock

  constructor(private readonly deps: AutoDreamDeps) {
    this.now = deps.now ?? Date.now
    this.lock = deps.lock ?? new MaintenanceLock(deps.state.lockPath, this.now)
  }

  // Called from the extraction coordinator's persisted update after a session was extracted.
  static noteSession(state: AutodreamState, sessionID: string): void {
    if (!state.sessionsSince.includes(sessionID)) state.sessionsSince.push(sessionID)
  }

  shouldRun(): boolean {
    const { config, state } = this.deps
    if (!config.autodream.enabled) return false
    return shouldRunAutodream(state.read().autodream, config.autodream, this.now())
  }

  // Runs a consolidation call when the gate passes. Success resets the gate; failure leaves the
  // gate untouched so the next extracted session retries.
  async maybeRun(): Promise<boolean> {
    if (!this.shouldRun()) return false
    if (!this.lock.tryAcquire()) {
      this.deps.log("info", "Auto-dream skipped: another process holds the maintenance lock")
      return false
    }

    const { store, config, generate, state, log } = this.deps
    try {
      // Re-check under the lock: another process may have consolidated while we waited to acquire.
      if (!this.shouldRun()) return false
      const autodream = state.read().autodream
      const memories = formatMemoriesForDream(store)
      if (memories.count === 0) return false
      if (memories.text.length > MAX_AUTODREAM_PROMPT_CHARS) {
        log("warn", "Auto-dream skipped: the memory set is too large to consolidate in one pass", {
          chars: memories.text.length,
          limit: MAX_AUTODREAM_PROMPT_CHARS,
        })
        return false
      }
      log("info", "Auto-dream consolidation starting", {
        sessionsSince: autodream.sessionsSince.length,
        lastConsolidatedAt: autodream.lastConsolidatedAt,
      })
      const reply = await generate("autodream", buildAutodreamPrompt(memories.text), config.autodream.timeoutMs)
      const plan = parseDreamReply(reply)
      const backup = backupMemoryDir(store, this.now())
      const outcome = applyDream(store, plan, memories.count)
      state.update((data) => {
        data.autodream.lastConsolidatedAt = this.now()
        data.autodream.sessionsSince = []
      })
      log("info", "Auto-dream consolidation completed", { ...outcome, backup })
      return true
    } catch (error) {
      log("error", "Auto-dream consolidation failed", { error: getErrorMessage(error) })
      return false
    } finally {
      this.lock.release()
    }
  }
}
