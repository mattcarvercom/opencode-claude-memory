import { describe, expect, test } from "bun:test"
import { createGenerateText, createTaskGenerator, extractJsonObject, modelForTask, parseModelRef } from "../src/llm.js"
import { TimeoutError } from "../src/util/timeout.js"
import { makeConfig } from "./helpers/index.js"

describe("parseModelRef", () => {
  test("splits provider and model at the first slash", () => {
    expect(parseModelRef("deepseek/deepseek-flash")).toEqual({ providerID: "deepseek", id: "deepseek-flash" })
    expect(parseModelRef("openrouter/anthropic/claude-haiku-4-5")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-haiku-4-5",
    })
    expect(parseModelRef(undefined)).toBeUndefined()
    expect(parseModelRef("nomodel")).toBeUndefined()
    expect(parseModelRef("/x")).toBeUndefined()
    expect(parseModelRef("x/")).toBeUndefined()
  })
})

describe("modelForTask", () => {
  test("a section model beats the global model, which beats the server default", () => {
    const config = makeConfig({ model: "a/global", extract: { model: "b/extract" } })
    expect(modelForTask(config, "extract")).toEqual({ providerID: "b", id: "extract" })
    expect(modelForTask(config, "recall")).toEqual({ providerID: "a", id: "global" })
    expect(modelForTask(makeConfig({}), "autodream")).toBeUndefined()
  })
})

describe("createGenerateText", () => {
  test("passes prompt, model and signal to ctx.generate.text and returns the text", async () => {
    const seen: unknown[] = []
    const generate = createGenerateText({
      generate: {
        text: async (input: unknown, options: unknown) => {
          seen.push([input, options])
          return { text: "reply" }
        },
      },
    } as never)
    const signal = new AbortController().signal
    expect(await generate("hi", { model: { providerID: "p", id: "m" }, signal })).toBe("reply")
    expect(seen).toEqual([[{ prompt: "hi", model: { providerID: "p", id: "m" } }, { signal }]])
    expect(await generate("bare")).toBe("reply")
    expect(seen[1]).toEqual([{ prompt: "bare" }, undefined])
  })

  test("returns an empty string when the reply carries no text", async () => {
    const generate = createGenerateText({ generate: { text: async () => ({}) } } as never)
    expect(await generate("x")).toBe("")
  })
})

describe("createTaskGenerator", () => {
  test("resolves the model per task", async () => {
    const calls: unknown[] = []
    const config = makeConfig({ model: "a/global", recall: { model: "b/recall" } })
    const run = createTaskGenerator(async (prompt, options) => {
      calls.push([prompt, options?.model])
      return "ok"
    }, config)
    await run("recall", "p1", 1_000)
    await run("extract", "p2", 1_000)
    expect(calls).toEqual([
      ["p1", { providerID: "b", id: "recall" }],
      ["p2", { providerID: "a", id: "global" }],
    ])
  })

  test("aborts and rejects with a TimeoutError when the call hangs", async () => {
    let aborted = false
    const run = createTaskGenerator(
      (_prompt, options) =>
        new Promise<string>(() => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true
          })
        }),
      makeConfig({}),
    )
    await expect(run("recall", "p", 20)).rejects.toBeInstanceOf(TimeoutError)
    expect(aborted).toBe(true)
  })
})

describe("extractJsonObject", () => {
  test("parses plain, fenced and prose-wrapped objects", () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 })
    expect(extractJsonObject('```json\n{"a": {"b": [1, 2]}}\n```')).toEqual({ a: { b: [1, 2] } })
    expect(extractJsonObject('Here you go: {"a": 1} hope that helps {not json}')).toEqual({ a: 1 })
  })

  test("rejects arrays, garbage and empty input", () => {
    expect(extractJsonObject("[1, 2]")).toBeUndefined()
    expect(extractJsonObject("{broken")).toBeUndefined()
    expect(extractJsonObject("")).toBeUndefined()
  })
})
