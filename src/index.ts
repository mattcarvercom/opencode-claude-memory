import type { Plugin } from "@opencode/plugin"
import { parseConfig } from "./config.js"
import { ExtractionCoordinator } from "./extraction/ExtractionCoordinator.js"
import { createGenerateText, createTaskGenerator } from "./llm.js"
import { buildMemorySystemPrompt } from "./prompt/systemPrompt.js"
import { formatRecalledMemories } from "./recall/format.js"
import { RecallCoordinator } from "./recall/RecallCoordinator.js"
import type { ContextEvent, PluginContext, PluginEvent, SessionMessage, SessionReader, SessionSummary } from "./sdk.js"
import { MemoryStore } from "./store/MemoryStore.js"
import { resolveMemoryRoot } from "./store/paths.js"
import { buildMemoryTools } from "./tools.js"
import { createLogger, getErrorMessage } from "./util/log.js"

export const PLUGIN_ID = "opencode-claude-memory"

function sessionReader(ctx: PluginContext): SessionReader {
  return {
    context: async (sessionID) => (await ctx.session.context({ sessionID })) as unknown as readonly SessionMessage[],
    get: async (sessionID) => (await ctx.session.get({ sessionID })) as unknown as SessionSummary | undefined,
  }
}

// Assembly only. Every piece of mutable state lives on the coordinators created here, so a server
// that hosts several directories gets fully isolated instances. `env` is injectable so tests never
// touch the real environment (CLAUDE_CONFIG_DIR is the only variable read, see config.ts).
export const createMemoryPlugin = (env?: NodeJS.ProcessEnv): Plugin.Plugin => ({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = parseConfig(ctx.options, env)
    const directory = ctx.location.directory
    const store = new MemoryStore(resolveMemoryRoot(ctx.location.project.canonical, directory), config)
    const log = createLogger(`${store.stateDir}/plugin.log`)
    const generate = createTaskGenerator(createGenerateText(ctx), config)
    const recall = new RecallCoordinator({ store, config, generate })
    const extraction = new ExtractionCoordinator({
      store,
      config,
      generate,
      sessions: sessionReader(ctx),
      directory,
      log,
    })
    extraction.start()

    // Memory tools are direct tool calls (`codemode: false`), not hidden behind OpenCode's `execute`.
    const tools = buildMemoryTools(store, (sessionID) => extraction.recordSave(sessionID))
    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          options: tool.options,
          execute: (input: unknown, context: { sessionID?: string }) => tool.execute(input, context),
        } as never)
      }
    })

    await ctx.session.hook("context", async (event) => {
      const { sessionID, messages, system } = event as unknown as ContextEvent
      let outcome: Awaited<ReturnType<RecallCoordinator["onContext"]>> = { ignored: false, recalled: [] }
      try {
        outcome = await recall.onContext(sessionID, messages)
      } catch (error) {
        log("warn", "Memory recall failed", { error: getErrorMessage(error) })
      }
      system.push({
        type: "text",
        text: buildMemorySystemPrompt(store, formatRecalledMemories(outcome.recalled), {
          includeIndex: !outcome.ignored,
        }),
      })
    })

    const events = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        const pluginEvent = event as unknown as PluginEvent
        if (pluginEvent.type === "session.deleted" && pluginEvent.data?.sessionID) {
          recall.onSessionDeleted(pluginEvent.data.sessionID)
        }
        extraction.onEvent(pluginEvent)
      }
    })().catch((error) => {
      if (!events.signal.aborted) log("error", "Event subscription ended", { error: getErrorMessage(error) })
    })

    return () => {
      events.abort()
      extraction.dispose()
    }
  },
})

const plugin: Plugin.Plugin = createMemoryPlugin()
export default plugin

export { type MemoryConfig, type MemoryOptions, MemoryOptionsSchema } from "./config.js"
export { MemoryStore } from "./store/MemoryStore.js"
