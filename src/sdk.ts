// Local shapes for the OpenCode 2 plugin SDK. The plugin hands over rich, branded schema types; only
// the fields this plugin actually reads are modelled here, so the code base never depends on the
// full schema package at runtime and tests can build plain objects.
import type { Plugin } from "@opencode/plugin"

export type PluginContext = Plugin.Context

export type ModelRef = { providerID: string; id: string }

// `ctx.generate.text`: one stateless model call, no session. `signal` cancels the request.
export type GenerateText = (prompt: string, options?: { model?: ModelRef; signal?: AbortSignal }) => Promise<string>

export type ContextPart = { type?: string; text?: string; name?: string }

// A message in the `session.hook("context")` request: `{ id, role, content: [{ type: "text", text }] }`.
export type ContextMessage = { id?: string; role?: string; content?: readonly ContextPart[] | string }

export type SystemPart = { type: "text"; text: string }

export type ContextEvent = {
  readonly sessionID: string
  system: SystemPart[]
  messages: ContextMessage[]
}

// A persisted message from `ctx.session.context`.
export type SessionPart = {
  type?: string
  text?: string
  name?: string
  state?: { status?: string; content?: ReadonlyArray<{ type?: string; text?: string }> }
}

export type SessionMessage = {
  id: string
  type: string
  text?: string
  time?: { created?: number; completed?: number }
  content?: readonly SessionPart[]
}

export type SessionSummary = {
  id: string
  parentID?: string
  location?: { directory?: string }
}

// Everything the coordinators need from the plugin context, so tests can supply plain fakes.
export type SessionReader = {
  context(sessionID: string): Promise<readonly SessionMessage[]>
  get(sessionID: string): Promise<SessionSummary | undefined>
}

export type PluginEvent = { type: string; data?: { sessionID?: string } }
