// Per-session recall state: whether the user asked to ignore memory and the in-flight selector
// prefetch for the current turn. One instance per plugin instance.
//
// Two kinds of state live here with different lifetimes: the turn cache (prefetch, recalled
// memories) is evicted after SESSION_STATE_TTL_MS so a long-running server does not leak; the
// user's "ignore memory" instruction is a session preference and lasts until `session.deleted` or
// an explicit resume. Eviction never clears it, and a session seen for the first time derives it
// from the conversation history so a restart does not silently bring memory back.
//
// The `context` hook runs before every model call. The first call of a turn starts the selector and
// waits for it at most recall.waitMs; later calls of the same turn (tool loops) reuse the result, so
// the recalled section stays identical across the turn and recall runs once per user message.
import type { MemoryConfig } from "../config.js"
import { deriveIgnoredFromHistory, detectIgnoreMemory, detectResumeMemory } from "../hooks/ignore.js"
import { buildTurnID, getLastUserQuery } from "../hooks/messages.js"
import type { TaskGenerator } from "../llm.js"
import type { ContextMessage } from "../sdk.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { type RecalledMemory, recallSelectedMemories } from "./format.js"
import { selectRelevantMemoryFilenames } from "./selector.js"

export const SESSION_STATE_TTL_MS = 60 * 60 * 1000

type Prefetch = {
  promise: Promise<RecalledMemory[]>
  result?: RecalledMemory[]
}

type SessionState = {
  updatedAt: number
  ignored: boolean
  turnID?: string
  prefetch?: Prefetch
}

export type RecallCoordinatorDeps = {
  store: MemoryStore
  config: MemoryConfig
  generate: TaskGenerator | undefined
  now?: () => number
}

export type RecallOutcome = {
  ignored: boolean
  recalled: RecalledMemory[]
}

const TIMEOUT = Symbol("recall-timeout")

function isUsefulRecallQuery(query: string | undefined): query is string {
  const trimmed = query?.trim()
  if (!trimmed) return false
  if (/\s/.test(trimmed)) return true
  return /[㐀-鿿]/.test(trimmed) && trimmed.length >= 4
}

export class RecallCoordinator {
  private readonly sessions = new Map<string, SessionState>()
  private readonly now: () => number

  constructor(private readonly deps: RecallCoordinatorDeps) {
    this.now = deps.now ?? Date.now
  }

  // `context` hook: derive the turn state, start the selector on a new turn and wait (bounded by
  // recall.waitMs) for its result. On timeout the prefetch keeps running for the next model call.
  async onContext(sessionID: string, messages: readonly ContextMessage[]): Promise<RecallOutcome> {
    const turn = getLastUserQuery(messages)
    const now = this.now()
    this.evictStale(now)
    const state = this.sessions.get(sessionID) ?? { updatedAt: now, ignored: deriveIgnoredFromHistory(messages) }
    state.updatedAt = now

    const turnID = buildTurnID(sessionID, turn)
    if (state.turnID !== turnID) {
      if (detectIgnoreMemory(turn.query)) state.ignored = true
      else if (state.ignored && detectResumeMemory(turn.query)) state.ignored = false
      state.turnID = turnID
      state.prefetch = state.ignored ? undefined : this.startPrefetch(turn.query)
    }
    this.sessions.set(sessionID, state)

    if (state.ignored) return { ignored: true, recalled: [] }
    const prefetch = state.prefetch
    if (!prefetch) return { ignored: false, recalled: [] }
    if (prefetch.result) return { ignored: false, recalled: prefetch.result }

    const result = await this.race(prefetch.promise, this.deps.config.recall.waitMs)
    return { ignored: false, recalled: result === TIMEOUT ? [] : result }
  }

  isIgnored(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.sessions.get(sessionID)?.ignored === true
  }

  onSessionDeleted(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  get trackedSessions(): number {
    return this.sessions.size
  }

  private race(promise: Promise<RecalledMemory[]>, waitMs: number): Promise<RecalledMemory[] | typeof TIMEOUT> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), waitMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  // Drops the turn cache of sessions idle for longer than the TTL. An ignored session keeps its
  // entry (only the cache is cleared) so the instruction survives until the session is deleted.
  private evictStale(now: number): void {
    const cutoff = now - SESSION_STATE_TTL_MS
    for (const [id, state] of this.sessions) {
      if (state.updatedAt >= cutoff) continue
      if (state.ignored) {
        state.prefetch = undefined
        state.turnID = undefined
      } else {
        this.sessions.delete(id)
      }
    }
  }

  private startPrefetch(query: string | undefined): Prefetch | undefined {
    const { generate, config, store } = this.deps
    if (!config.recall.enabled || !generate || !isUsefulRecallQuery(query)) return undefined

    const headers = store.scan()
    if (headers.length === 0) return undefined

    const prefetch: Prefetch = {
      promise: selectRelevantMemoryFilenames({
        generate,
        query,
        memories: headers,
        timeoutMs: config.recall.timeoutMs,
        maxMemories: config.recall.maxMemories,
      })
        .then((selected) =>
          recallSelectedMemories(headers, selected, new Set(), { maxMemories: config.recall.maxMemories }),
        )
        .catch(() => [] as RecalledMemory[])
        .then((recalled) => {
          prefetch.result = recalled
          return recalled
        }),
    }
    return prefetch
  }
}
