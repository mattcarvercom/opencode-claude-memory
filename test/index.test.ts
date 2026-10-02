import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import plugin, { createMemoryPlugin, MemoryOptionsSchema, MemoryStore, PLUGIN_ID } from "../src/index.js"
import { AUTO_MEMORY_MARKER } from "../src/prompt/systemPrompt.js"
import { MEMORY_TOOL_NAMES } from "../src/tools.js"
import {
  cleanupTempDirs,
  contextMessage,
  deferred,
  makePlugin,
  memoriesReply,
  selectionReply,
  sessionAssistant,
  sessionUser,
  sleep,
  tempDir,
  userContext,
} from "./helpers/index.js"

afterEach(cleanupTempDirs)

const DB_MEMORY = {
  file_name: "database_rules",
  name: "Database Test Rules",
  description: "Rules for database integration tests",
  type: "feedback",
  content: "Run integration tests against a real database, not mocks.",
}

describe("plugin module shape", () => {
  test("default export is a V2 plugin definition and the named exports are the public API", () => {
    expect(plugin.id).toBe(PLUGIN_ID)
    expect(typeof plugin.setup).toBe("function")
    expect(typeof createMemoryPlugin).toBe("function")
    expect(MemoryOptionsSchema.safeParse({}).success).toBe(true)
    expect(typeof MemoryStore).toBe("function")
  })

  test("registers the five memory tools as direct tools, one context hook and one event subscription", async () => {
    const host = await makePlugin()
    expect([...host.tools.keys()]).toEqual([...MEMORY_TOOL_NAMES])
    for (const tool of host.tools.values()) expect(tool.options).toEqual({ codemode: false })
    expect(host.hookCount()).toBe(1)
    host.cleanup()
  })

  test("invalid plugin options fail at load time with the offending path", async () => {
    await expect(makePlugin({ options: { extract: { enabled: "yes" } } })).rejects.toThrow(/extract\.enabled/)
  })

  test("cleanup ends the event subscription", async () => {
    const host = await makePlugin()
    await sleep(5)
    expect(host.subscribers()).toBe(1)
    host.cleanup()
    expect(host.subscribers()).toBe(0)
  })
})

describe("system prompt injection", () => {
  test("uses the directory as memory root when the project canonical path is the filesystem root", async () => {
    const project = tempDir("ocm-project-")
    const host = await makePlugin({ canonical: "/", directory: project })
    const expected = new MemoryStore(project, { claudeConfigDir: host.claudeConfigDir }).memoryDir
    const rootDir = new MemoryStore("/", { claudeConfigDir: host.claudeConfigDir }).memoryDir
    const [prompt = ""] = await host.runContext("ses_root", [userContext("hi")])
    expect(prompt).toContain(expected)
    expect(prompt).not.toContain(rootDir)
    host.cleanup()
  })

  test("appends one system segment carrying the marker and the index", async () => {
    const host = await makePlugin()
    await host.runTool("memory_save", { ...DB_MEMORY, name: "Visible Memory" })
    const system = await host.runContext("ses_normal", [userContext("What do you remember about visible context?")])
    expect(system).toHaveLength(1)
    expect(system[0]?.startsWith(AUTO_MEMORY_MARKER)).toBe(true)
    expect(system[0]).toContain("## MEMORY.md")
    expect(system[0]).toContain("Visible Memory")
    host.cleanup()
  })

  test("suppresses the index for the rest of the session when the user asks to ignore memory", async () => {
    const host = await makePlugin()
    await host.runTool("memory_save", { ...DB_MEMORY, name: "Hidden Memory" })
    const ignoring = userContext("Ignore memory and answer from fresh context only.", "m1")

    const [first = ""] = await host.runContext("ses_ignore", [ignoring])
    expect(first).toContain("# Auto Memory")
    expect(first).not.toContain("## MEMORY.md")
    expect(first).not.toContain("Hidden Memory")
    expect(first).not.toContain("## Recalled Memories")

    const [second = ""] = await host.runContext("ses_ignore", [
      ignoring,
      userContext("Now tell me about the hidden memory", "m2"),
    ])
    expect(second).not.toContain("## MEMORY.md")
    expect(host.generateCalls).toHaveLength(0)

    host.emit({ type: "session.deleted", data: { sessionID: "ses_ignore" } })
    await sleep(5)
    const [after = ""] = await host.runContext("ses_ignore", [userContext("hello again, what is new?", "m3")])
    expect(after).toContain("## MEMORY.md")
    host.cleanup()
  })

  test("a failing recall never breaks the model call", async () => {
    const host = await makePlugin()
    host.setGenerate(() => {
      throw new Error("model down")
    })
    await host.runTool("memory_save", DB_MEMORY)
    const [prompt = ""] = await host.runContext("ses_fail", [userContext("How should we test database changes?", "m1")])
    expect(prompt).toContain("## MEMORY.md")
    expect(prompt).not.toContain("## Recalled Memories")
    host.cleanup()
  })
})

describe("recall end to end", () => {
  test("a turn gets recalled memories in the system prompt through ctx.generate.text with the configured model", async () => {
    const host = await makePlugin({ options: { model: "deepseek/deepseek-flash" } })
    host.setGenerate((request) =>
      request.prompt.includes("database_rules.md") ? selectionReply("database_rules.md") : selectionReply(),
    )
    await host.runTool("memory_save", DB_MEMORY)
    await host.runTool("memory_save", {
      file_name: "release_notes",
      name: "Release Notes",
      description: "Release process checklist",
      type: "project",
      content: "Update the changelog before publishing.",
    })

    const [prompt = ""] = await host.runContext("real-session", [
      userContext("How should we test database changes?", "user-message-1"),
    ])

    expect(host.generateCalls).toHaveLength(1)
    const call = host.generateCalls[0]
    expect(call?.input.model).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
    expect(call?.input.prompt).toContain("Query: How should we test database changes?")
    expect(call?.input.prompt).toContain("database_rules.md")
    expect(call?.input.prompt).toContain("release_notes.md")
    expect(call?.options?.signal).toBeInstanceOf(AbortSignal)

    const recalled = prompt.split("## Recalled Memories")[1] ?? ""
    expect(recalled).toContain("Database Test Rules")
    expect(recalled).toContain("Run integration tests against a real database, not mocks.")
    expect(recalled).not.toContain("Release Notes")
    host.cleanup()
  })

  test("the same recalled section is reused for every model call of the turn", async () => {
    const host = await makePlugin()
    host.setGenerate(() => selectionReply("database_rules.md"))
    await host.runTool("memory_save", DB_MEMORY)
    const user = userContext("How should we test database changes?", "m1")
    const [first = ""] = await host.runContext("ses_loop", [user])
    const [second = ""] = await host.runContext("ses_loop", [user, contextMessage("assistant", "let me check")])
    expect(first).toContain("## Recalled Memories")
    expect(second).toBe(first)
    expect(host.generateCalls).toHaveLength(1)
    host.cleanup()
  })

  test("a slow selector is not awaited beyond recall.waitMs and shows up on the next call", async () => {
    const gate = deferred<string>()
    const host = await makePlugin({ options: { recall: { waitMs: 20 } } })
    host.setGenerate(() => gate.promise)
    await host.runTool("memory_save", DB_MEMORY)
    const messages = [userContext("How should we test database changes?", "m1")]

    const [first = ""] = await host.runContext("ses_slow", messages)
    expect(first).toContain("## MEMORY.md")
    expect(first).not.toContain("## Recalled Memories")

    gate.resolve(selectionReply("database_rules.md"))
    await sleep(5)
    const [second = ""] = await host.runContext("ses_slow", messages)
    expect(second).toContain("## Recalled Memories")
    expect(second).toContain("Database Test Rules")
    host.cleanup()
  })
})

describe("instance isolation", () => {
  test("two plugin instances in one process do not share state", async () => {
    const claudeConfigDir = tempDir("ocm-claude-")
    const a = await makePlugin({ claudeConfigDir })
    const b = await makePlugin({ claudeConfigDir })

    await a.runContext("ses_shared", [userContext("Ignore memory for now.", "m1")])
    expect((await a.runContext("ses_shared", [userContext("and now?", "m2")]))[0]).not.toContain("## MEMORY.md")
    expect((await b.runContext("ses_shared", [userContext("and now?", "m2")]))[0]).toContain("## MEMORY.md")

    await a.runTool("memory_save", DB_MEMORY)
    expect(await b.runTool("memory_list", {})).toBe("No memories saved yet.")
    expect(await a.runTool("memory_list", {})).toContain("1 memories found")
    a.cleanup()
    b.cleanup()
  })
})

describe("extraction end to end", () => {
  const userRole = {
    fileName: "user_role",
    name: "User Role",
    description: "Backend engineer on the API team",
    content: "The user is a backend engineer who owns the API service.",
  }
  const testing = {
    fileName: "feedback_tests",
    name: "Run real tests",
    description: "Prefers integration tests",
    type: "feedback" as const,
    content: "Run integration tests against a real database.",
  }

  test("session.idle extracts through generate.text and saves what the model returns", async () => {
    const host = await makePlugin({ options: { extract: { debounceMs: 0 }, autodream: { enabled: false } } })
    host.setGenerate(() => memoriesReply(userRole, testing, userRole))
    host.sessions.messages.set("parent-session", [
      sessionUser(
        "I am a backend engineer on the API team; always run integration tests against a real database.",
        1,
        "u1",
      ),
      sessionAssistant("Noted.", { id: "a1", created: 2 }),
    ])

    host.emit({ type: "session.idle", data: { sessionID: "parent-session" } })
    await sleep(40)

    expect(host.generateCalls).toHaveLength(1)
    expect(host.generateCalls[0]?.input.prompt).toContain("## Existing memories")
    expect(host.generateCalls[0]?.input.prompt).toContain("always run integration tests")

    const store = new MemoryStore(host.directory, { claudeConfigDir: host.claudeConfigDir })
    expect(store.read("user_role")?.body).toBe(userRole.content)
    expect(store.read("feedback_tests")?.type).toBe("feedback")
    expect(store.readIndex().trim().split("\n")).toHaveLength(2)

    const stateFile = join(store.stateDir, "extraction-state.json")
    expect(existsSync(stateFile)).toBe(true)
    expect(JSON.parse(readFileSync(stateFile, "utf-8")).sessions["parent-session"].lastExtractedMessageID).toBe("a1")
    host.cleanup()
  })

  test("a memory_save by the agent skips the model round for that session", async () => {
    const host = await makePlugin({ options: { extract: { debounceMs: 0 }, autodream: { enabled: false } } })
    host.sessions.messages.set("ses_agent", [
      sessionUser("Remember that PostgreSQL is my preferred database.", 1, "u1"),
      sessionAssistant("Saved.", { id: "a1", created: 2 }),
    ])
    await host.runTool("memory_save", DB_MEMORY, "ses_agent")
    host.emit({ type: "session.idle", data: { sessionID: "ses_agent" } })
    await sleep(40)
    expect(host.generateCalls).toHaveLength(0)
    host.cleanup()
  })

  test("sessions of other directories on the same server are ignored", async () => {
    const host = await makePlugin({ options: { extract: { debounceMs: 0 } } })
    host.sessions.messages.set("foreign", [sessionUser("Remember that PostgreSQL is my preferred database.", 1, "u1")])
    host.sessions.infos.set("foreign", { id: "foreign", location: { directory: "/somewhere/else" } })
    host.emit({ type: "session.idle", data: { sessionID: "foreign" } })
    await sleep(40)
    expect(host.generateCalls).toHaveLength(0)
    host.cleanup()
  })

  test("no extraction happens after cleanup", async () => {
    const host = await makePlugin({ options: { extract: { debounceMs: 0 } } })
    host.sessions.messages.set("late", [sessionUser("Remember that PostgreSQL is my preferred database.", 1, "u1")])
    host.cleanup()
    host.emit({ type: "session.idle", data: { sessionID: "late" } })
    await sleep(30)
    expect(host.generateCalls).toHaveLength(0)
  })
})
