import { MEMORY_TYPES } from "./store/frontmatter.js"
import type { MemoryStore } from "./store/MemoryStore.js"

const FILE_NAME_HINT = 'with or without the .md extension; sub-directories are allowed, e.g. "team/conventions"'

export const MEMORY_TOOL_NAMES = [
  "memory_save",
  "memory_delete",
  "memory_list",
  "memory_search",
  "memory_read",
] as const

export type MemoryToolContext = { sessionID?: string }

export type MemoryTool = {
  name: (typeof MEMORY_TOOL_NAMES)[number]
  description: string
  input: Record<string, unknown>
  // `codemode: false` keeps the tool a direct tool call instead of moving it behind OpenCode's `execute`.
  options: { codemode: false }
  execute(input: unknown, context: MemoryToolContext): Promise<{ content: string }>
}

type Args = Record<string, unknown>

function str(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== "string") throw new Error(`"${key}" must be a string`)
  return value
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false }
}

const string = (description: string) => ({ type: "string", description })

function format(content: string): { content: string } {
  return { content }
}

// `onSave` reports every write so the extraction coordinator can skip a round the agent already
// curated itself.
export function buildMemoryTools(
  store: MemoryStore,
  onSave?: (sessionID: string | undefined, fileName: string) => void,
) {
  const tools: MemoryTool[] = [
    {
      name: "memory_save",
      description:
        "Save or update a memory for future conversations. " +
        "Each memory is stored as a markdown file with frontmatter. " +
        "Use this when the user explicitly asks you to remember something, " +
        "or when you observe important information worth preserving across sessions " +
        "(user preferences, feedback, project context, external references). " +
        "Check existing memories first with memory_list or memory_search to avoid duplicates.",
      input: schema(
        {
          file_name: string(
            'File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"; a sub-directory prefix such as "team/conventions" is allowed',
          ),
          name: string("Human-readable name for this memory"),
          description: string("One-line description. Used to decide relevance in future conversations, so be specific"),
          type: {
            type: "string",
            enum: [...MEMORY_TYPES],
            description:
              "Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)",
          },
          content: string(
            "Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines",
          ),
        },
        ["file_name", "name", "description", "type", "content"],
      ),
      options: { codemode: false },
      async execute(input, context) {
        const args = input as Args
        const type = str(args, "type")
        if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
          throw new Error(`"type" must be one of: ${MEMORY_TYPES.join(", ")}`)
        }
        const outcome = store.save({
          fileName: str(args, "file_name"),
          name: str(args, "name"),
          description: str(args, "description"),
          type: type as (typeof MEMORY_TYPES)[number],
          content: str(args, "content"),
        })
        onSave?.(context?.sessionID, outcome.fileName)
        return format(
          outcome.unchanged
            ? `Skipped: "${outcome.fileName}" already exists with identical content, nothing written (${outcome.filePath}).`
            : `Memory saved to ${outcome.filePath}`,
        )
      },
    },
    {
      name: "memory_delete",
      description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
      input: schema({ file_name: string(`File name of the memory to delete (${FILE_NAME_HINT})`) }, ["file_name"]),
      options: { codemode: false },
      async execute(input) {
        const fileName = str(input as Args, "file_name")
        const { deleted, trashedTo } = store.delete(fileName)
        if (!deleted) return format(`Memory "${fileName}" not found.`)
        return format(
          trashedTo
            ? `Memory "${fileName}" deleted (a copy was kept at ${trashedTo}).`
            : `Memory "${fileName}" deleted.`,
        )
      },
    },
    {
      name: "memory_list",
      description:
        "List all saved memories with their names, types, and descriptions. " +
        "Use this to check what memories exist before saving a new one (to avoid duplicates) " +
        "or when you need to recall what's been stored.",
      input: schema({}, []),
      options: { codemode: false },
      async execute() {
        const entries = store.list()
        if (entries.length === 0) return format("No memories saved yet.")
        const lines = entries.map((e) => `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}`)
        return format(`${entries.length} memories found:\n${lines.join("\n")}`)
      },
    },
    {
      name: "memory_search",
      description:
        "Search memories by keyword. Searches across names, descriptions, and content. " +
        "Use this to find relevant memories before answering questions or when the user references past conversations.",
      input: schema({ query: string("Search query: searches across name, description, and content") }, ["query"]),
      options: { codemode: false },
      async execute(input) {
        const query = str(input as Args, "query")
        const results = store.search(query)
        if (results.length === 0) return format(`No memories matching "${query}".`)
        const lines = results.map(
          (e) =>
            `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}\n  Content: ${e.body.slice(0, 200)}${e.body.length > 200 ? "..." : ""}`,
        )
        return format(`${results.length} matches for "${query}":\n${lines.join("\n")}`)
      },
    },
    {
      name: "memory_read",
      description: "Read the full content of a specific memory file.",
      input: schema({ file_name: string(`File name of the memory to read (${FILE_NAME_HINT})`) }, ["file_name"]),
      options: { codemode: false },
      async execute(input) {
        const fileName = str(input as Args, "file_name")
        const entry = store.read(fileName)
        if (!entry) return format(`Memory "${fileName}" not found.`)
        return format(
          `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.body}`,
        )
      },
    },
  ]
  return tools
}
