import { afterEach, describe, expect, test } from "bun:test"
import { buildMemoryTools, MEMORY_TOOL_NAMES } from "../src/tools.js"
import { cleanupTempDirs, makeStore } from "./helpers/index.js"

afterEach(cleanupTempDirs)

describe("buildMemoryTools", () => {
  function setup() {
    const store = makeStore()
    const saves: Array<[string | undefined, string]> = []
    const tools = buildMemoryTools(store, (sessionID, fileName) => void saves.push([sessionID, fileName]))
    const run = async (name: string, input: Record<string, unknown>, sessionID?: string) => {
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error(`no tool ${name}`)
      return (await tool.execute(input, { sessionID })).content
    }
    return { store, saves, tools, run }
  }

  const saveArgs = {
    file_name: "title_verification",
    name: "Title Verification Test",
    description: "Verifies the tool lifecycle",
    type: "reference",
    content: "Used to validate the tool flow end to end.",
  }

  test("registers the five tools as direct (non-code-mode) tools with object schemas", () => {
    const { tools } = setup()
    expect(tools.map((t) => t.name)).toEqual([...MEMORY_TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.options).toEqual({ codemode: false })
      expect(tool.input).toMatchObject({ type: "object", additionalProperties: false })
      expect(tool.description.length).toBeGreaterThan(10)
    }
    const save = tools.find((t) => t.name === "memory_save")
    expect(save?.input).toMatchObject({
      required: ["file_name", "name", "description", "type", "content"],
      properties: { type: { enum: ["user", "feedback", "project", "reference"] } },
    })
  })

  test("runs the full lifecycle", async () => {
    const { run, store } = setup()

    expect(await run("memory_save", saveArgs)).toStartWith("Memory saved to ")
    expect(await run("memory_save", saveArgs)).toStartWith('Skipped: "title_verification.md" already exists')

    const list = await run("memory_list", {})
    expect(list).toContain("1 memories found")
    expect(list).toContain("Title Verification Test")
    expect(list).toContain("[title_verification.md]")

    const search = await run("memory_search", { query: "lifecycle" })
    expect(search).toContain("1 matches")
    expect(search).toContain("Title Verification Test")

    const read = await run("memory_read", { file_name: "title_verification.md" })
    expect(read).toContain("# Title Verification Test")
    expect(read).toContain("**Type:** reference")

    expect(await run("memory_delete", { file_name: "title_verification.md" })).toBe(
      'Memory "title_verification.md" deleted.',
    )
    expect(store.readIndex()).toBe("")

    expect(await run("memory_list", {})).toBe("No memories saved yet.")
    expect(await run("memory_search", { query: "nothing" })).toBe('No memories matching "nothing".')
    expect(await run("memory_read", { file_name: "nope" })).toBe('Memory "nope" not found.')
    expect(await run("memory_delete", { file_name: "nope" })).toBe('Memory "nope" not found.')
  })

  test("rejects invalid input before persistence", async () => {
    const { run, store } = setup()
    await expect(run("memory_save", { ...saveArgs, name: undefined })).rejects.toThrow('"name" must be a string')
    await expect(run("memory_save", { ...saveArgs, type: "gossip" })).rejects.toThrow('"type" must be one of')
    await expect(run("memory_save", { ...saveArgs, name: "" })).rejects.toThrow("Memory name is required")
    expect(store.read("title_verification")).toBeNull()
    expect(store.readIndex()).toBe("")
  })

  test("reports every save with the calling session", async () => {
    const { run, saves } = setup()
    await run("memory_save", saveArgs, "main")
    await run("memory_save", { ...saveArgs, content: "changed" }, "other")
    expect(saves).toEqual([
      ["main", "title_verification.md"],
      ["other", "title_verification.md"],
    ])
  })

  test("accepts sub-directory names in every tool", async () => {
    const { run } = setup()
    await run("memory_save", { ...saveArgs, file_name: "team/conventions" })
    expect(await run("memory_read", { file_name: "team/conventions" })).toContain("# Title Verification Test")
    expect(await run("memory_list", {})).toContain("[team/conventions.md]")
    expect(await run("memory_delete", { file_name: "team/conventions.md" })).toContain("deleted")
  })
})
