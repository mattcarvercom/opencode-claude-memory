// Turns a model reply into memory store writes. The model never touches files: it answers with a
// JSON object and everything below validates it before anything is written.
import { extractJsonObject } from "../llm.js"
import { MEMORY_TYPES, type MemoryType } from "../store/frontmatter.js"
import type { MemoryStore, SaveMemoryInput } from "../store/MemoryStore.js"

export const MAX_EXTRACTED_MEMORIES = 5

export class ReplyFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReplyFormatError"
  }
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value)
}

function toDraft(raw: unknown): SaveMemoryInput | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const item = raw as Record<string, unknown>
  const { file_name: fileName, name, description, type, content } = item
  if (typeof fileName !== "string" || !fileName.trim()) return undefined
  if (typeof content !== "string" || !content.trim()) return undefined
  if (!isMemoryType(type)) return undefined
  const trimmedName = typeof name === "string" && name.trim() ? name.trim() : fileName.trim()
  return {
    fileName: fileName.trim(),
    name: trimmedName,
    description: typeof description === "string" ? description.trim() : "",
    type,
    content,
  }
}

function drafts(value: unknown): SaveMemoryInput[] {
  return Array.isArray(value) ? value.map(toDraft).filter((d): d is SaveMemoryInput => d !== undefined) : []
}

function parseReply(text: string): Record<string, unknown> {
  const reply = extractJsonObject(text)
  if (!reply) throw new ReplyFormatError("the model reply did not contain a JSON object")
  return reply
}

export function parseExtractionReply(text: string): SaveMemoryInput[] {
  const reply = parseReply(text)
  if (!Array.isArray(reply.memories)) throw new ReplyFormatError('the model reply has no "memories" array')
  return drafts(reply.memories)
}

export type DreamPlan = { save: SaveMemoryInput[]; delete: string[] }

export function parseDreamReply(text: string): DreamPlan {
  const reply = parseReply(text)
  if (!Array.isArray(reply.save) && !Array.isArray(reply.delete)) {
    throw new ReplyFormatError('the model reply has neither a "save" nor a "delete" array')
  }
  const toDelete = Array.isArray(reply.delete)
    ? reply.delete.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  return { save: drafts(reply.save), delete: toDelete }
}

export type ExtractionOutcome = { saved: string[]; skipped: string[] }

// Extraction only creates memories: a draft whose file already exists, or that repeats an earlier
// draft's file name, is skipped. Updating existing memories is left to the agent and to auto-dream.
export function applyExtraction(
  store: MemoryStore,
  memories: readonly SaveMemoryInput[],
  max = MAX_EXTRACTED_MEMORIES,
): ExtractionOutcome {
  const outcome: ExtractionOutcome = { saved: [], skipped: [] }
  const seen = new Set<string>()
  for (const memory of memories) {
    if (outcome.saved.length >= max) {
      outcome.skipped.push(memory.fileName)
      continue
    }
    try {
      if (seen.has(memory.fileName) || store.read(memory.fileName)) {
        outcome.skipped.push(memory.fileName)
        continue
      }
      seen.add(memory.fileName)
      const result = store.save(memory)
      if (!result.unchanged) outcome.saved.push(result.fileName)
    } catch {
      outcome.skipped.push(memory.fileName)
    }
  }
  return outcome
}

export type DreamOutcome = { saved: string[]; deleted: string[]; skipped: string[] }

// Consolidation may replace and delete. As a guard against a bad reply, deleting more than half of
// the memories in one pass is refused outright (saves still apply). Deleting a memory another tool
// created keeps a copy in the trash (MemoryStore.delete).
export function applyDream(store: MemoryStore, plan: DreamPlan, totalBefore: number): DreamOutcome {
  const outcome: DreamOutcome = { saved: [], deleted: [], skipped: [] }
  for (const memory of plan.save) {
    try {
      const result = store.save(memory)
      if (!result.unchanged) outcome.saved.push(result.fileName)
    } catch {
      outcome.skipped.push(memory.fileName)
    }
  }
  const limit = Math.max(1, Math.floor(totalBefore / 2))
  if (plan.delete.length > limit) {
    outcome.skipped.push(...plan.delete)
    return outcome
  }
  const keep = new Set(plan.save.map((memory) => memory.fileName.replace(/\.md$/, "")))
  for (const fileName of plan.delete) {
    if (keep.has(fileName.replace(/\.md$/, ""))) continue
    try {
      if (store.delete(fileName).deleted) outcome.deleted.push(fileName)
      else outcome.skipped.push(fileName)
    } catch {
      outcome.skipped.push(fileName)
    }
  }
  return outcome
}
