import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MemoryConfig, parseConfig } from "../../src/config.js"
import { createMemoryPlugin } from "../../src/index.js"
import type { LlmTask, TaskGenerator } from "../../src/llm.js"
import type {
  ContextMessage,
  PluginContext,
  PluginEvent,
  SessionMessage,
  SessionPart,
  SessionReader,
  SessionSummary,
} from "../../src/sdk.js"
import { MemoryStore, type SaveMemoryInput } from "../../src/store/MemoryStore.js"
import type { Logger } from "../../src/util/log.js"

// ─── temp directories ────────────────────────────────────────────────────────

const tempDirs: string[] = []

export function tempDir(prefix = "ocm-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export function tempGitRepo(prefix = "ocm-repo-"): string {
  const dir = tempDir(prefix)
  mkdirSync(join(dir, ".git"), { recursive: true })
  return dir
}

// Windows only allows symbolic links for administrators / developer mode; the link tests skip
// themselves elsewhere instead of failing the whole run.
let symlinkSupport: boolean | undefined
export function canSymlink(): boolean {
  if (symlinkSupport === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "ocm-symlink-probe-"))
    try {
      writeFileSync(join(dir, "target"), "")
      symlinkSync(join(dir, "target"), join(dir, "link"), "file")
      symlinkSupport = true
    } catch {
      symlinkSupport = false
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return symlinkSupport
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

// ─── config / store ──────────────────────────────────────────────────────────

export function makeConfig(options: unknown = {}, claudeConfigDir = tempDir("ocm-claude-")): MemoryConfig {
  return parseConfig(options, { CLAUDE_CONFIG_DIR: claudeConfigDir })
}

export function makeStore(root: string = tempGitRepo(), claudeConfigDir = tempDir("ocm-claude-")): MemoryStore {
  return new MemoryStore(root, { claudeConfigDir })
}

export function seedMemory(store: MemoryStore, input: Partial<SaveMemoryInput> & { fileName: string }): string {
  const result = store.save({
    name: input.name ?? input.fileName,
    description: input.description ?? `${input.fileName} description`,
    type: input.type ?? "user",
    content: input.content ?? `${input.fileName} content`,
    fileName: input.fileName,
  })
  return result.filePath
}

export function writeRawMemory(memoryDir: string, filename: string, content: string, mtime?: Date): string {
  const filePath = join(memoryDir, ...filename.split("/"))
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  if (mtime) utimesSync(filePath, mtime, mtime)
  return filePath
}

export const noopLog: Logger = () => {}

export function collectingLog(): { log: Logger; entries: Array<{ level: string; message: string; extra?: unknown }> } {
  const entries: Array<{ level: string; message: string; extra?: unknown }> = []
  return { entries, log: (level, message, extra) => void entries.push({ level, message, extra }) }
}

// ─── model calls ─────────────────────────────────────────────────────────────

export type GenerateCall = { task: LlmTask; prompt: string; timeoutMs: number }

export type Reply = string | Error | ((call: GenerateCall, index: number) => string | Promise<string>)

// A TaskGenerator that records every call and answers from a list (the last reply repeats), or from
// a function. An Error reply rejects.
export function makeGenerate(replies: Reply | Reply[] = '{"selected_memories": []}') {
  const calls: GenerateCall[] = []
  const list = Array.isArray(replies) ? replies : [replies]
  const generate: TaskGenerator = async (task, prompt, timeoutMs) => {
    const call = { task, prompt, timeoutMs }
    const index = calls.length
    calls.push(call)
    const reply = list[Math.min(index, list.length - 1)]
    if (reply instanceof Error) throw reply
    return typeof reply === "function" ? reply(call, index) : (reply ?? "")
  }
  return { generate, calls }
}

export function selectionReply(...filenames: string[]): string {
  return JSON.stringify({ selected_memories: filenames })
}

export function memoriesReply(...memories: Array<Partial<SaveMemoryInput> & { fileName: string }>): string {
  return JSON.stringify({
    memories: memories.map((m) => ({
      file_name: m.fileName,
      name: m.name ?? m.fileName,
      description: m.description ?? `${m.fileName} description`,
      type: m.type ?? "user",
      content: m.content ?? `${m.fileName} content`,
    })),
  })
}

export function deps(
  overrides: {
    store?: MemoryStore
    config?: MemoryConfig
    generate?: TaskGenerator
    sessions?: SessionReader
    directory?: string
    log?: Logger
    now?: () => number
  } = {},
) {
  const store = overrides.store ?? makeStore()
  const config = overrides.config ?? makeConfig({}, store.claudeConfigDir)
  return {
    store,
    config,
    generate: overrides.generate,
    sessions: overrides.sessions,
    directory: overrides.directory ?? store.memoryRoot,
    log: overrides.log ?? noopLog,
    now: overrides.now,
  }
}

// ─── messages ────────────────────────────────────────────────────────────────

let messageSeq = 0

// A message of the `context` hook request.
export function contextMessage(role: "user" | "assistant" | "tool", text: string, id?: string): ContextMessage {
  messageSeq += 1
  return { id: id ?? `msg_${messageSeq}`, role, content: [{ type: "text", text }] }
}

export function userContext(text: string, id?: string): ContextMessage {
  return contextMessage("user", text, id)
}

export function sessionUser(text: string, created?: number, id?: string): SessionMessage {
  messageSeq += 1
  return { id: id ?? `msg_${messageSeq}`, type: "user", text, time: { created: created ?? messageSeq } }
}

export function textPart(text: string): SessionPart {
  return { type: "text", text }
}

export function toolPart(
  name: string,
  output = "",
  status: "completed" | "error" | "running" = "completed",
): SessionPart {
  return { type: "tool", name, state: { status, content: [{ type: "text", text: output }] } }
}

// Assistant messages are complete by default (`time.completed` set), matching what the server
// reports once a turn has finished; pass `completed: false` to model one still streaming.
export function sessionAssistant(
  parts: SessionPart[] | string,
  options: { created?: number; completed?: boolean; id?: string } = {},
): SessionMessage {
  messageSeq += 1
  const created = options.created ?? messageSeq
  return {
    id: options.id ?? `msg_${messageSeq}`,
    type: "assistant",
    content: typeof parts === "string" ? [textPart(parts)] : parts,
    time: options.completed === false ? { created } : { created, completed: created },
  }
}

export type MockSessions = SessionReader & {
  messages: Map<string, SessionMessage[]>
  infos: Map<string, SessionSummary>
  contextCalls: string[]
}

// Sessions located in `directory` unless an info is registered explicitly.
export function makeSessions(directory: string, sessions: Record<string, SessionMessage[]> = {}): MockSessions {
  const messages = new Map(Object.entries(sessions))
  const infos = new Map<string, SessionSummary>()
  const contextCalls: string[] = []
  return {
    messages,
    infos,
    contextCalls,
    async context(sessionID) {
      contextCalls.push(sessionID)
      return messages.get(sessionID) ?? []
    },
    async get(sessionID) {
      return infos.get(sessionID) ?? (messages.has(sessionID) ? { id: sessionID, location: { directory } } : undefined)
    },
  }
}

export type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ─── fake plugin context ─────────────────────────────────────────────────────

export type RegisteredTool = {
  name: string
  description: string
  input: { properties: Record<string, unknown>; required: string[] }
  options?: { codemode?: boolean }
  execute(input: unknown, context: { sessionID?: string }): Promise<{ content: string }>
}

export type GenerateTextCall = {
  input: { prompt: string; model?: { providerID: string; id: string } }
  options?: { signal?: AbortSignal }
}

export type FakeHost = {
  ctx: PluginContext
  claudeConfigDir: string
  directory: string
  tools: Map<string, RegisteredTool>
  generateCalls: GenerateTextCall[]
  sessions: MockSessions
  setGenerate(reply: (input: GenerateTextCall["input"], index: number) => string | Promise<string>): void
  // Runs every registered `context` hook the way OpenCode does before a model call.
  runContext(sessionID: string, messages: ContextMessage[]): Promise<string[]>
  emit(event: PluginEvent): void
  runTool(name: string, input: Record<string, unknown>, sessionID?: string): Promise<string>
  hookCount(): number
  subscribers(): number
}

export function makeFakeHost(
  input: { directory?: string; options?: unknown; claudeConfigDir?: string; canonical?: string } = {},
): FakeHost {
  const directory = input.directory ?? tempGitRepo()
  const claudeConfigDir = input.claudeConfigDir ?? tempDir("ocm-claude-")
  const tools = new Map<string, RegisteredTool>()
  const contextHooks: Array<(event: unknown) => Promise<void> | void> = []
  const generateCalls: GenerateTextCall[] = []
  const sessions = makeSessions(directory)
  let generateReply: (input: GenerateTextCall["input"], index: number) => string | Promise<string> = () =>
    '{"selected_memories": []}'
  const queue: PluginEvent[] = []
  const waiters: Array<(value: IteratorResult<PluginEvent>) => void> = []
  let subscriberCount = 0

  const ctx = {
    location: { directory, project: { id: "global", directory, canonical: input.canonical ?? directory } },
    options: input.options ?? {},
    tool: {
      async transform(callback: (editor: { add(tool: RegisteredTool): void }) => void) {
        callback({ add: (tool) => void tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
    },
    session: {
      async hook(name: string, callback: (event: unknown) => Promise<void> | void) {
        if (name === "context") contextHooks.push(callback)
        return { dispose: async () => {} }
      },
      context: async ({ sessionID }: { sessionID: string }) => sessions.context(sessionID),
      get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID),
    },
    generate: {
      async text(request: GenerateTextCall["input"], options?: GenerateTextCall["options"]) {
        const index = generateCalls.length
        generateCalls.push({ input: request, options })
        return { text: await generateReply(request, index) }
      },
    },
    event: {
      subscribe({ signal }: { signal?: AbortSignal } = {}): AsyncIterable<PluginEvent> {
        subscriberCount += 1
        signal?.addEventListener("abort", () => {
          subscriberCount -= 1
          for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true })
        })
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              const next = queue.shift()
              if (next) return Promise.resolve({ value: next, done: false })
              if (signal?.aborted) return Promise.resolve({ value: undefined as never, done: true })
              return new Promise<IteratorResult<PluginEvent>>((resolve) => waiters.push(resolve))
            },
          }),
        }
      },
    },
  } as unknown as PluginContext

  return {
    ctx,
    claudeConfigDir,
    directory,
    tools,
    generateCalls,
    sessions,
    setGenerate: (reply) => {
      generateReply = reply
    },
    async runContext(sessionID, messages) {
      const event = { sessionID, system: [] as Array<{ type: "text"; text: string }>, messages }
      for (const hook of contextHooks) await hook(event)
      return event.system.map((part) => part.text)
    },
    emit(event) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value: event, done: false })
      else queue.push(event)
    },
    async runTool(name, args, sessionID = "ses_test") {
      const tool = tools.get(name)
      if (!tool) throw new Error(`tool ${name} not registered`)
      return (await tool.execute(args, { sessionID })).content
    },
    hookCount: () => contextHooks.length,
    subscribers: () => subscriberCount,
  }
}

// Sets the plugin up against a fake host and returns the host plus the plugin's cleanup function.
export async function makePlugin(input: Parameters<typeof makeFakeHost>[0] = {}) {
  const host = makeFakeHost(input)
  const plugin = createMemoryPlugin({ CLAUDE_CONFIG_DIR: host.claudeConfigDir })
  const cleanup = (await plugin.setup(host.ctx)) as (() => void) | undefined
  return Object.assign(host, { cleanup: cleanup ?? (() => {}) })
}
