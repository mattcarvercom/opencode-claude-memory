// LLM memory selection, ported from Claude Code's findRelevantMemories.ts side query. Runs as one
// stateless `generate.text` call, so the main conversation never sees the selector exchange.
import { extractJsonObject, type TaskGenerator } from "../llm.js"
import { formatMemoryManifest, type MemoryHeader } from "../store/scan.js"

export const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to OpenCode as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to OpenCode as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
`

export const SELECT_MEMORIES_REPLY_FORMAT =
  'Reply with a single JSON object and nothing else: {"selected_memories": ["<filename>", ...]}. Use the filenames exactly as listed.'

export type SelectRelevantMemoryFilenamesInput = {
  generate: TaskGenerator
  query: string
  memories: readonly MemoryHeader[]
  timeoutMs: number
  maxMemories: number
}

export function extractSelectedMemories(text: string): string[] {
  const selected = extractJsonObject(text)?.selected_memories
  if (!Array.isArray(selected)) return []
  return selected.filter((item): item is string => typeof item === "string")
}

export function buildSelectorPrompt(query: string, memories: readonly MemoryHeader[]): string {
  return `${SELECT_MEMORIES_SYSTEM_PROMPT}\nQuery: ${query}\n\nAvailable memories:\n${formatMemoryManifest(memories)}\n\n${SELECT_MEMORIES_REPLY_FORMAT}`
}

// Never throws: a failed or timed-out selector simply recalls nothing for this turn.
export async function selectRelevantMemoryFilenames(input: SelectRelevantMemoryFilenamesInput): Promise<string[]> {
  if (input.memories.length === 0) return []

  try {
    const reply = await input.generate("recall", buildSelectorPrompt(input.query, input.memories), input.timeoutMs)
    const validFilenames = new Set(input.memories.map((memory) => memory.filename))
    return extractSelectedMemories(reply)
      .filter((filename) => validFilenames.has(filename))
      .slice(0, input.maxMemories)
  } catch {
    return []
  }
}
