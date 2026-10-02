// The plugin's background model calls (recall selection, extraction, auto-dream) are plain
// `ctx.generate.text` requests: no child session, no hidden agent, nothing left behind in the
// user's session list. Each call carries its own deadline and AbortSignal.
import type { MemoryConfig } from "./config.js"
import type { GenerateText, ModelRef, PluginContext } from "./sdk.js"
import { withDeadline } from "./util/timeout.js"

export type LlmTask = "recall" | "extract" | "autodream"

export type TaskGenerator = (task: LlmTask, prompt: string, timeoutMs: number) => Promise<string>

// "provider/model" -> { providerID, id }. The model id keeps any further slashes.
export function parseModelRef(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

export function modelForTask(config: Pick<MemoryConfig, "model" | "recall" | "extract" | "autodream">, task: LlmTask) {
  return parseModelRef(config[task].model ?? config.model)
}

export function createGenerateText(ctx: Pick<PluginContext, "generate">): GenerateText {
  return async (prompt, options) => {
    const result = await ctx.generate.text(
      { prompt, ...(options?.model ? { model: options.model } : {}) } as never,
      options?.signal ? { signal: options.signal } : undefined,
    )
    return typeof result?.text === "string" ? result.text : ""
  }
}

export function createTaskGenerator(
  generate: GenerateText,
  config: Pick<MemoryConfig, "model" | "recall" | "extract" | "autodream">,
): TaskGenerator {
  return (task, prompt, timeoutMs) =>
    withDeadline(`${task} generate.text`, timeoutMs, (signal) =>
      generate(prompt, { model: modelForTask(config, task), signal }),
    )
}

// Pulls the first JSON object out of a model reply: tolerates a code fence and prose around it.
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [text, fenced?.[1]].filter((c): c is string => typeof c === "string")
  for (const candidate of candidates) {
    const start = candidate.indexOf("{")
    if (start < 0) continue
    // Try the widest span first, then shrink to the last closing brace that parses.
    for (let end = candidate.lastIndexOf("}"); end > start; end = candidate.lastIndexOf("}", end - 1)) {
      try {
        const parsed: unknown = JSON.parse(candidate.slice(start, end + 1))
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        // keep shrinking
      }
    }
  }
  return undefined
}
