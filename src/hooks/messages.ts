// Pure helpers over the message shape passed to the `context` session hook:
// `{ id, role: "user" | "assistant" | "tool", content: [{ type: "text", text }, ...] }`.
import type { ContextMessage, ContextPart } from "../sdk.js"

export type TurnInfo = {
  query?: string
  messageID?: string
  messageIndex?: number
}

export function roleOf(message: ContextMessage): string {
  return String(message.role ?? "")
}

function partsOf(message: ContextMessage): readonly ContextPart[] {
  return Array.isArray(message.content) ? message.content : []
}

export function extractUserQuery(message: ContextMessage): string | undefined {
  if (typeof message.content === "string") return message.content.trim() || undefined
  const text = partsOf(message)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim()
  return text || undefined
}

export function getLastUserQuery(messages: readonly ContextMessage[]): TurnInfo {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || roleOf(message) !== "user") continue
    return {
      query: extractUserQuery(message),
      messageID: typeof message.id === "string" ? message.id : undefined,
      messageIndex: i,
    }
  }
  return {}
}

// One user turn may drive several model calls (tool loops); they share a turn ID so recall runs once.
export function buildTurnID(sessionID: string, turn: TurnInfo): string {
  return `${sessionID}:${turn.messageID ?? `${turn.messageIndex ?? -1}:${turn.query ?? ""}`}`
}
