import { describe, expect, test } from "bun:test"
import { deriveIgnoredFromHistory, detectIgnoreMemory, detectResumeMemory } from "../src/hooks/ignore.js"
import { buildTurnID, extractUserQuery, getLastUserQuery } from "../src/hooks/messages.js"
import { contextMessage, userContext } from "./helpers/index.js"

describe("messages helpers", () => {
  test("extractUserQuery joins text parts and ignores other part types", () => {
    const msg = {
      id: "m",
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "tool-call", name: "grep" },
        { type: "text", text: "second" },
      ],
    }
    expect(extractUserQuery(msg)).toBe("first\nsecond")
    expect(extractUserQuery({ role: "user", content: [] })).toBeUndefined()
    expect(extractUserQuery({ role: "user", content: "plain string" })).toBe("plain string")
    expect(extractUserQuery({ role: "user" })).toBeUndefined()
  })

  test("getLastUserQuery returns the last user message with its id", () => {
    const messages = [
      userContext("older", "m1"),
      contextMessage("assistant", "reply"),
      userContext("newest", "m3"),
      contextMessage("assistant", "streaming"),
    ]
    expect(getLastUserQuery(messages)).toEqual({ query: "newest", messageID: "m3", messageIndex: 2 })
    expect(getLastUserQuery([])).toEqual({})
  })

  test("buildTurnID prefers the message id and falls back to index + query", () => {
    expect(buildTurnID("s", { messageID: "m1", messageIndex: 3, query: "q" })).toBe("s:m1")
    expect(buildTurnID("s", { messageIndex: 3, query: "q" })).toBe("s:3:q")
    expect(buildTurnID("s", {})).toBe("s:-1:")
  })
})

describe("ignore helpers", () => {
  test("detects ignore-memory requests", () => {
    for (const query of [
      "Ignore memory and answer from fresh context only.",
      "please don't use the memory here",
      "Do not use your memory",
      "answer without memory",
      "skip memory for this one",
      "memory should be ignored",
    ]) {
      expect(detectIgnoreMemory(query)).toBe(true)
    }
    expect(detectIgnoreMemory("what do you remember about databases?")).toBe(false)
    expect(detectIgnoreMemory(undefined)).toBe(false)
  })

  test("detects resume-memory requests", () => {
    for (const query of ["use memory again", "ok, enable the memory", "turn memory back on", "stop ignoring memory"]) {
      expect(detectResumeMemory(query)).toBe(true)
    }
    expect(detectResumeMemory("what should I use for memory profiling?")).toBe(false)
  })

  test("deriveIgnoredFromHistory replays user messages in order", () => {
    expect(deriveIgnoredFromHistory([userContext("hi")])).toBe(false)
    expect(deriveIgnoredFromHistory([userContext("ignore memory"), userContext("next question")])).toBe(true)
    expect(deriveIgnoredFromHistory([userContext("ignore memory"), userContext("use memory again")])).toBe(false)
    expect(deriveIgnoredFromHistory([contextMessage("assistant", "ignore memory")])).toBe(false)
  })
})
