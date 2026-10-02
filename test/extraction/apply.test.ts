import { afterEach, describe, expect, test } from "bun:test"
import {
  applyDream,
  applyExtraction,
  MAX_EXTRACTED_MEMORIES,
  parseDreamReply,
  parseExtractionReply,
  ReplyFormatError,
} from "../../src/extraction/apply.js"
import { cleanupTempDirs, makeStore, memoriesReply, seedMemory } from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("parseExtractionReply", () => {
  test("maps wire fields to drafts and drops invalid entries", () => {
    const reply = JSON.stringify({
      memories: [
        { file_name: "good", name: "Good", description: "d", type: "feedback", content: "c" },
        { file_name: "bad_type", name: "x", description: "d", type: "gossip", content: "c" },
        { file_name: "", name: "x", description: "d", type: "user", content: "c" },
        { file_name: "no_content", name: "x", description: "d", type: "user", content: "  " },
        "nonsense",
        { file_name: "no_name", type: "user", content: "c" },
      ],
    })
    expect(parseExtractionReply(reply)).toEqual([
      { fileName: "good", name: "Good", description: "d", type: "feedback", content: "c" },
      { fileName: "no_name", name: "no_name", description: "", type: "user", content: "c" },
    ])
  })

  test("an empty list is a valid answer; a missing list or no JSON is a format error", () => {
    expect(parseExtractionReply('{"memories": []}')).toEqual([])
    expect(() => parseExtractionReply('{"memory": []}')).toThrow(ReplyFormatError)
    expect(() => parseExtractionReply("I saved nothing.")).toThrow(ReplyFormatError)
  })
})

describe("applyExtraction", () => {
  test("creates new memories and indexes them", () => {
    const store = makeStore()
    const drafts = parseExtractionReply(memoriesReply({ fileName: "user_role", type: "user" }))
    expect(applyExtraction(store, drafts)).toEqual({ saved: ["user_role.md"], skipped: [] })
    expect(store.read("user_role")?.body).toBe("user_role content")
    expect(store.readIndex()).toContain("user_role.md")
  })

  test("never overwrites an existing memory and skips repeated file names", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "existing", content: "original" })
    const drafts = parseExtractionReply(
      memoriesReply({ fileName: "existing", content: "new" }, { fileName: "fresh" }, { fileName: "fresh" }),
    )
    expect(applyExtraction(store, drafts)).toEqual({ saved: ["fresh.md"], skipped: ["existing", "fresh"] })
    expect(store.read("existing")?.body).toBe("original")
  })

  test("caps the number of memories saved in one round", () => {
    const store = makeStore()
    const names = Array.from({ length: MAX_EXTRACTED_MEMORIES + 2 }, (_, i) => ({ fileName: `m${i}` }))
    const outcome = applyExtraction(store, parseExtractionReply(memoriesReply(...names)))
    expect(outcome.saved).toHaveLength(MAX_EXTRACTED_MEMORIES)
    expect(outcome.skipped).toEqual([`m${MAX_EXTRACTED_MEMORIES}`, `m${MAX_EXTRACTED_MEMORIES + 1}`])
  })

  test("a draft with an invalid file name is skipped without aborting the rest", () => {
    const store = makeStore()
    const drafts = parseExtractionReply(memoriesReply({ fileName: "../escape" }, { fileName: "ok" }))
    expect(applyExtraction(store, drafts)).toEqual({ saved: ["ok.md"], skipped: ["../escape"] })
  })
})

describe("parseDreamReply", () => {
  test("reads save and delete lists", () => {
    const plan = parseDreamReply(
      JSON.stringify({
        save: [{ file_name: "merged", name: "M", description: "d", type: "project", content: "c" }],
        delete: ["old_a", "", 3, "old_b"],
      }),
    )
    expect(plan.save).toHaveLength(1)
    expect(plan.delete).toEqual(["old_a", "old_b"])
  })

  test("either list alone is enough; neither is a format error", () => {
    expect(parseDreamReply('{"delete": ["a"]}')).toEqual({ save: [], delete: ["a"] })
    expect(() => parseDreamReply('{"summary": "done"}')).toThrow(ReplyFormatError)
    expect(() => parseDreamReply("done")).toThrow(ReplyFormatError)
  })
})

describe("applyDream", () => {
  test("replaces saved memories and deletes the listed ones", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "a", content: "old a" })
    seedMemory(store, { fileName: "b", content: "old b" })
    seedMemory(store, { fileName: "c", content: "keep" })
    const plan = {
      save: parseExtractionReply(memoriesReply({ fileName: "a", content: "merged a and b" })),
      delete: ["b.md"],
    }
    expect(applyDream(store, plan, 3)).toEqual({ saved: ["a.md"], deleted: ["b.md"], skipped: [] })
    expect(store.read("a")?.body).toBe("merged a and b")
    expect(store.read("b")).toBeNull()
    expect(store.read("c")?.body).toBe("keep")
  })

  test("refuses to delete more than half of the memories but still applies saves", () => {
    const store = makeStore()
    for (const name of ["a", "b", "c", "d"]) seedMemory(store, { fileName: name })
    const plan = {
      save: parseExtractionReply(memoriesReply({ fileName: "a", content: "rewritten" })),
      delete: ["b", "c", "d"],
    }
    const outcome = applyDream(store, plan, 4)
    expect(outcome.saved).toEqual(["a.md"])
    expect(outcome.deleted).toEqual([])
    expect(outcome.skipped).toEqual(["b", "c", "d"])
    expect(store.read("d")).not.toBeNull()
  })

  test("never deletes a memory it also saves, and reports missing deletes as skipped", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "a" })
    seedMemory(store, { fileName: "b" })
    seedMemory(store, { fileName: "c" })
    const plan = { save: parseExtractionReply(memoriesReply({ fileName: "a", content: "x" })), delete: ["a", "ghost"] }
    const outcome = applyDream(store, plan, 6)
    expect(outcome.deleted).toEqual([])
    expect(outcome.skipped).toEqual(["ghost"])
    expect(store.read("a")?.body).toBe("x")
  })
})
