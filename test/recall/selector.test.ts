import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  buildSelectorPrompt,
  extractSelectedMemories,
  SELECT_MEMORIES_REPLY_FORMAT,
  SELECT_MEMORIES_SYSTEM_PROMPT,
  selectRelevantMemoryFilenames,
} from "../../src/recall/selector.js"
import type { MemoryHeader } from "../../src/store/scan.js"
import { makeGenerate, selectionReply } from "../helpers/index.js"

function header(filename: string, description: string): MemoryHeader {
  return {
    filename,
    filePath: join("/tmp/memory", filename),
    mtimeMs: new Date("2026-05-01T00:00:00Z").getTime(),
    name: filename.replace(/\.md$/, ""),
    description,
    type: "project",
    hasFrontmatter: true,
  }
}

const memories = [header("testing.md", "Database integration test guidance"), header("release.md", "Release process")]
const base = { query: "How should we run database integration tests?", memories, timeoutMs: 1_000, maxMemories: 5 }

describe("selectRelevantMemoryFilenames", () => {
  test("asks one model call for filenames and keeps only listed ones", async () => {
    const { generate, calls } = makeGenerate(selectionReply("testing.md", "missing.md"))
    const selected = await selectRelevantMemoryFilenames({ ...base, generate })

    expect(selected).toEqual(["testing.md"])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.task).toBe("recall")
    expect(calls[0]?.timeoutMs).toBe(1_000)
    const prompt = calls[0]?.prompt ?? ""
    expect(prompt).toContain(SELECT_MEMORIES_SYSTEM_PROMPT)
    expect(prompt).toContain("Query: How should we run database integration tests?")
    expect(prompt).toContain("testing.md")
    expect(prompt).toContain("Release process")
    expect(prompt).toContain(SELECT_MEMORIES_REPLY_FORMAT)
  })

  test("caps the result at maxMemories", async () => {
    const { generate } = makeGenerate(selectionReply("testing.md", "release.md"))
    expect(await selectRelevantMemoryFilenames({ ...base, generate, maxMemories: 1 })).toEqual(["testing.md"])
  })

  test("makes no call without memories", async () => {
    const { generate, calls } = makeGenerate()
    expect(await selectRelevantMemoryFilenames({ ...base, generate, memories: [] })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test("never throws: a failing or unparsable call selects nothing", async () => {
    expect(
      await selectRelevantMemoryFilenames({ ...base, generate: makeGenerate(new Error("down")).generate }),
    ).toEqual([])
    expect(await selectRelevantMemoryFilenames({ ...base, generate: makeGenerate("no json here").generate })).toEqual(
      [],
    )
  })
})

describe("extractSelectedMemories", () => {
  test("reads the JSON object, tolerating a code fence and surrounding prose", () => {
    expect(extractSelectedMemories('{"selected_memories": ["a.md", 3, "b.md"]}')).toEqual(["a.md", "b.md"])
    expect(extractSelectedMemories('Sure!\n```json\n{"selected_memories": ["a.md"]}\n```\nDone.')).toEqual(["a.md"])
    expect(extractSelectedMemories('{"selected_memories": "a.md"}')).toEqual([])
    expect(extractSelectedMemories("")).toEqual([])
  })
})

describe("buildSelectorPrompt", () => {
  test("lists the query and the manifest", () => {
    const prompt = buildSelectorPrompt("hello world", memories)
    expect(prompt).toContain("Query: hello world")
    expect(prompt).toContain("Available memories:")
    expect(prompt).toContain("testing.md")
  })
})
