import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { dirname } from "node:path"

export const LOG_SERVICE = "opencode-claude-memory"
export const MAX_LOG_BYTES = 512 * 1024

export type LogLevel = "debug" | "info" | "warn" | "error"

export type Logger = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

// OpenCode 2 gives plugins no log channel and anything written to stderr lands in the chat UI, so
// the plugin keeps its own JSON-lines log file next to its state. The file is truncated once it
// passes MAX_LOG_BYTES. Every call is best-effort and never throws.
export function createLogger(file: string | undefined): Logger {
  return (level, message, extra) => {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size > MAX_LOG_BYTES) truncateSync(file, 0)
      } catch {
        // no file yet
      }
      const line = JSON.stringify({ time: new Date().toISOString(), service: LOG_SERVICE, level, message, ...extra })
      appendFileSync(file, `${line}\n`)
    } catch {
      // best-effort
    }
  }
}
