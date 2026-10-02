// Incremental post-session memory extraction driven by `session.idle` events, with a persisted
// watermark per session. Each round reads the new messages, asks the model (one stateless
// `generate.text` call) for memories worth keeping and writes them to the store itself.
import type { MemoryConfig } from "../config.js"
import type { TaskGenerator } from "../llm.js"
import type { PluginEvent, SessionMessage, SessionReader } from "../sdk.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { getErrorMessage, type Logger } from "../util/log.js"
import { TimeoutError, withDeadline } from "../util/timeout.js"
import { applyExtraction, parseExtractionReply } from "./apply.js"
import { AutoDream } from "./autodream.js"
import { MaintenanceLock } from "./lock.js"
import { buildExtractionPrompt } from "./prompts.js"
import { ExtractionStateStore, migrateLegacyAutodreamState, type SessionExtractionState } from "./state.js"

export const MAX_EXTRACTION_FAILURES = 3
export const MIN_CONVERSATION_CHARS = 20
// Deadline for the plain SDK reads (`session.context`, `session.get`); see util/timeout.ts.
export const SDK_READ_TIMEOUT_MS = 30_000

function messageTime(message: SessionMessage): { created?: number; completed?: number } {
  const time = message.time
  return {
    created: typeof time?.created === "number" ? time.created : undefined,
    completed: typeof time?.completed === "number" ? time.completed : undefined,
  }
}

// Messages after the watermark. If the watermark message was removed (revert / compaction), fall
// back to everything created after the watermark message's own time (not the fork's finish time:
// messages that arrived while the extraction ran must not be skipped).
export function sliceNewMessages(
  messages: readonly SessionMessage[],
  state: SessionExtractionState | undefined,
): SessionMessage[] {
  if (!state) return [...messages]
  if (state.lastExtractedMessageID) {
    const idx = messages.findIndex((m) => m.id === state.lastExtractedMessageID)
    if (idx >= 0) return messages.slice(idx + 1)
  }
  const boundary = state.lastMessageAt ?? state.updatedAt
  return messages.filter((m) => (messageTime(m).created ?? 0) > boundary)
}

// Drops assistant messages still being generated from the end of the slice: extracting them would
// record a watermark past content that is not final yet, and the final answer would never be seen.
export function trimIncompleteTail(messages: readonly SessionMessage[]): SessionMessage[] {
  let end = messages.length
  while (end > 0) {
    const message = messages[end - 1]
    if (!message || message.type !== "assistant" || messageTime(message).completed !== undefined) break
    end -= 1
  }
  return messages.slice(0, end)
}

export function hasExtractableUserMessage(messages: readonly SessionMessage[]): boolean {
  return messages.some((message) => message.type === "user" && typeof message.text === "string" && message.text.trim())
}

export function buildConversationForExtraction(messages: readonly SessionMessage[], maxChars: number): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.type === "user" && typeof message.text === "string" && message.text.trim()) {
      lines.push(`### User\n${message.text}`)
    } else if (message.type === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          lines.push(`### Assistant\n${part.text}`)
        } else if (part.type === "tool" && part.name && part.state?.status === "completed") {
          const output = (part.state.content ?? [])
            .map((item: { type?: string; text?: string }) =>
              item.type === "text" && typeof item.text === "string" ? item.text : "",
            )
            .join("")
          const out = output.length > 300 ? `${output.slice(0, 300)}…` : output
          lines.push(`_[tool ${part.name}: ${out}]_`)
        }
      }
    }
  }
  let text = lines.join("\n\n")
  // Keep the TAIL (newest turns carry the new facts worth extracting), drop the oldest head.
  if (text.length > maxChars) {
    text = `…[older turns truncated]\n\n${text.slice(-maxChars)}`
  }
  return text
}

export type ExtractionCoordinatorDeps = {
  store: MemoryStore
  config: MemoryConfig
  generate: TaskGenerator | undefined
  sessions: SessionReader | undefined
  // The plugin instance's directory: events arrive for every session on the server, only sessions
  // located here belong to this instance's memory.
  directory: string
  log: Logger
  now?: () => number
  state?: ExtractionStateStore
  lock?: MaintenanceLock
}

type Snapshot = {
  fresh: SessionMessage[]
  last: SessionMessage
  lastMessageAt: number | undefined
}

export class ExtractionCoordinator {
  readonly state: ExtractionStateStore
  readonly autodream: AutoDream | undefined
  private readonly lock: MaintenanceLock
  private readonly now: () => number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly busy = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly savedByMainAgent = new Set<string>()
  private readonly ownership = new Map<string, boolean>()
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: ExtractionCoordinatorDeps) {
    this.now = deps.now ?? Date.now
    this.state = deps.state ?? new ExtractionStateStore(deps.store.stateDir, this.now)
    this.lock = deps.lock ?? new MaintenanceLock(this.state.lockPath, this.now)
    this.autodream = deps.generate
      ? new AutoDream({ ...deps, generate: deps.generate, state: this.state, now: this.now, lock: this.lock })
      : undefined
  }

  get enabled(): boolean {
    return this.deps.config.extract.enabled && this.deps.generate !== undefined && this.deps.sessions !== undefined
  }

  // Carries v1's auto-dream timestamp over once so upgrading does not trigger an immediate pass.
  start(): void {
    const { store, log } = this.deps
    try {
      migrateLegacyAutodreamState(this.state, `${store.claudeConfigDir}/opencode-memory`, [
        store.gitRoot ?? store.memoryRoot,
        store.memoryRoot,
        store.canonicalRoot,
      ])
    } catch (error) {
      log("warn", "Could not migrate legacy auto-dream state", { error: getErrorMessage(error) })
    }
  }

  onEvent(event: PluginEvent): void {
    const sessionID = event.data?.sessionID
    if (!sessionID) return
    switch (event.type) {
      case "session.idle":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.onSessionIdle(sessionID)
        break
      case "session.execution.started":
        this.onSessionBusy(sessionID)
        break
      case "session.deleted":
        this.onSessionDeleted(sessionID)
        break
    }
  }

  onSessionIdle(sessionID: string): void {
    if (!this.enabled || this.disposed || !sessionID) return
    this.busy.delete(sessionID)
    this.clearTimer(sessionID)
    const timer = setTimeout(() => {
      this.timers.delete(sessionID)
      void this.enqueue(sessionID)
    }, this.deps.config.extract.debounceMs)
    timer.unref?.()
    this.timers.set(sessionID, timer)
  }

  // A session that starts a new turn cancels its pending debounce: the previous turn is extracted
  // together with the new one once the session is idle again.
  onSessionBusy(sessionID: string): void {
    if (!sessionID) return
    this.busy.add(sessionID)
    this.clearTimer(sessionID)
  }

  onSessionDeleted(sessionID: string): void {
    this.clearTimer(sessionID)
    this.busy.delete(sessionID)
    this.savedByMainAgent.delete(sessionID)
    this.ownership.delete(sessionID)
  }

  // memory_save reports every write: a save by the agent marks the session so the next extraction
  // round is skipped (the agent already curated its memory).
  recordSave(sessionID: string | undefined): void {
    if (sessionID) this.savedByMainAgent.add(sessionID)
  }

  // Resolves once every queued extraction has finished (tests, dispose).
  idle(): Promise<void> {
    return this.queue
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.busy.clear()
  }

  private clearTimer(sessionID: string): void {
    const existing = this.timers.get(sessionID)
    if (existing) clearTimeout(existing)
    this.timers.delete(sessionID)
  }

  private enqueue(sessionID: string): Promise<void> {
    const run = this.queue.then(() => this.runIncremental(sessionID)).catch(() => {})
    this.queue = run
    return run
  }

  // Events arrive for every session on the server. Only top-level sessions of this plugin
  // instance's directory are extracted; the answer is cached for the life of the session.
  private async isOwnSession(sessionID: string): Promise<boolean> {
    const cached = this.ownership.get(sessionID)
    if (cached !== undefined) return cached
    const { sessions, directory } = this.deps
    if (!sessions) return false
    const info = await withDeadline("session.get", SDK_READ_TIMEOUT_MS, () => sessions.get(sessionID))
    const own = info !== undefined && !info.parentID && info.location?.directory === directory
    this.ownership.set(sessionID, own)
    return own
  }

  private snapshot(
    messages: readonly SessionMessage[],
    previous: SessionExtractionState | undefined,
  ): Snapshot | undefined {
    const fresh = trimIncompleteTail(sliceNewMessages(messages, previous))
    const last = fresh[fresh.length - 1]
    if (!last || !hasExtractableUserMessage(fresh)) return undefined
    return { fresh, last, lastMessageAt: messageTime(last).created }
  }

  // Persists the watermark unless another process already moved it past this snapshot. Runs inside
  // the state lock, so the decision is made against the current on-disk state.
  private advance(sessionID: string, snapshot: Snapshot, extra: Partial<SessionExtractionState> = {}): boolean {
    let advanced = false
    this.state.update((data) => {
      const current = data.sessions[sessionID]
      if (
        current?.lastMessageAt !== undefined &&
        snapshot.lastMessageAt !== undefined &&
        current.lastMessageAt > snapshot.lastMessageAt
      ) {
        return
      }
      advanced = true
      data.sessions[sessionID] = {
        lastExtractedMessageID: snapshot.last.id,
        ...(snapshot.lastMessageAt !== undefined ? { lastMessageAt: snapshot.lastMessageAt } : {}),
        updatedAt: this.now(),
        failures: 0,
        ...extra,
      }
      AutoDream.noteSession(data.autodream, sessionID)
    })
    return advanced
  }

  private async runIncremental(sessionID: string): Promise<void> {
    const { generate, sessions, config, store, log } = this.deps
    if (!generate || !sessions || this.disposed || this.inFlight.has(sessionID)) return
    // Re-check at dequeue time: the debounce may have fired just before the session went busy, or
    // the session may have started a new turn while this job waited in the queue.
    if (this.busy.has(sessionID)) return
    this.inFlight.add(sessionID)

    try {
      if (!(await this.isOwnSession(sessionID))) return
      const messages = await withDeadline("session.context", SDK_READ_TIMEOUT_MS, () => sessions.context(sessionID))
      if (this.busy.has(sessionID)) return
      let snapshot = this.snapshot(messages, this.state.getSession(sessionID))
      if (!snapshot) return

      if (this.savedByMainAgent.delete(sessionID)) {
        if (this.advance(sessionID, snapshot)) await this.autodream?.maybeRun()
        return
      }

      if (
        buildConversationForExtraction(snapshot.fresh, config.extract.maxConversationChars).trim().length <
        MIN_CONVERSATION_CHARS
      ) {
        this.advance(sessionID, snapshot)
        return
      }

      // Cross-process serialisation (#30): another OpenCode process on this project is extracting or
      // consolidating right now. Skip without touching the watermark; the next idle retries.
      if (!this.lock.tryAcquire()) {
        log("info", "Memory extraction skipped: another process holds the maintenance lock", { sessionID })
        return
      }

      let extracted = false
      try {
        // Recompute against the state as it is *now*: while we waited for the lock another process
        // may have extracted part (or all) of this slice.
        const previous = this.state.getSession(sessionID)
        snapshot = this.snapshot(messages, previous)
        if (!snapshot) return
        const conversation = buildConversationForExtraction(snapshot.fresh, config.extract.maxConversationChars)
        if (conversation.trim().length < MIN_CONVERSATION_CHARS) {
          this.advance(sessionID, snapshot)
          return
        }

        try {
          const reply = await generate(
            "extract",
            buildExtractionPrompt(store.manifest(), conversation),
            config.extract.timeoutMs,
          )
          const outcome = applyExtraction(store, parseExtractionReply(reply))
          if (outcome.saved.length > 0 || outcome.skipped.length > 0) {
            log("info", "Memory extraction finished", { sessionID, ...outcome })
          }
        } catch (error) {
          const failures = (previous?.failures ?? 0) + 1
          log("error", "Memory extraction failed", { error: getErrorMessage(error), sessionID, failures })
          if (failures >= MAX_EXTRACTION_FAILURES) {
            // Do not stay stuck on a message that keeps failing: move on and reset the counter.
            this.advance(sessionID, snapshot)
          } else {
            this.state.update((data) => {
              data.sessions[sessionID] = {
                ...(data.sessions[sessionID] ?? previous ?? { updatedAt: 0 }),
                failures,
                attemptedAt: this.now(),
              }
            })
          }
          return
        }
        // The watermark is committed while the lock is still held, so no other process can run
        // an extraction between the writes and the watermark that records them.
        extracted = this.advance(sessionID, snapshot)
      } finally {
        this.lock.release()
      }

      if (extracted) await this.autodream?.maybeRun()
    } catch (error) {
      const detail = error instanceof TimeoutError ? error.message : getErrorMessage(error)
      log("error", "Memory extraction failed", { error: detail, sessionID })
    } finally {
      this.inFlight.delete(sessionID)
    }
  }
}
