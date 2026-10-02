// The only copies of the extraction and auto-dream prompts. Both run as one stateless model call
// that answers with a JSON object; the plugin applies the result to the memory store itself.

export const EXTRACT_PROMPT = `You are the memory extraction step. The conversation below is reviewed for anything worth remembering for future sessions.

## What to save

There are four memory types:

1. **user** - Who the user is: role, expertise, preferences, communication style. Helps tailor future interactions.
2. **feedback** - Guidance on how to work: corrections ("don't do X"), confirmations ("yes, keep doing that"), approach preferences. Include *why* so edge cases can be judged.
3. **project** - Ongoing work context: goals, deadlines, initiatives, decisions, bugs. NOT derivable from code/git. Convert relative dates to absolute.
4. **reference** - Pointers to external resources: URLs, tool names, where to find information outside the codebase.

## What NOT to save

- Code patterns, architecture, file structure - derivable from the codebase
- Git history, recent changes - use \`git log\`/\`git blame\`
- Debugging solutions - the fix is in the code
- Anything already in AGENTS.md / project config files
- Ephemeral task details or current conversation context
- Information that is already covered by an existing memory (see the list below)

## Instructions

1. Analyze the conversation for memorable information.
2. Each memory is one object with: \`file_name\` (descriptive snake_case slug without extension, e.g. \`user_role\`, \`feedback_testing_approach\`), \`name\` (short title), \`description\` (one line, used for relevance matching in future sessions), \`type\` (user, feedback, project or reference) and \`content\`. For feedback and project memories structure the content as: rule/fact, then **Why:** and **How to apply:** lines.
3. Never reuse the \`file_name\` of an existing memory: existing memories are never overwritten here. If something extends an existing memory, skip it.
4. If the conversation was trivial (e.g. just "hello" or a quick lookup), save nothing. That is fine.
5. Be selective: 0-3 memories per conversation is typical. Quality over quantity.
6. Do NOT save a memory about the extraction process itself.

## Reply format

Reply with a single JSON object and nothing else: {"memories": [{"file_name": "...", "name": "...", "description": "...", "type": "...", "content": "..."}]}. Use {"memories": []} when nothing is worth saving.`

export const EXTRACT_EXISTING_MEMORIES_HEADING = "## Existing memories"
export const EXTRACT_CONVERSATION_HEADING = "## Conversation"

export function buildExtractionPrompt(manifest: string, conversation: string): string {
  const inventory = manifest.trim() ? manifest.trim() : "(none yet)"
  return `${EXTRACT_PROMPT}\n\n${EXTRACT_EXISTING_MEMORIES_HEADING}\n\n${inventory}\n\n${EXTRACT_CONVERSATION_HEADING}\n\n${conversation}`
}

export const AUTODREAM_PROMPT = `You are performing an auto-dream memory consolidation pass.

Goal: tighten and de-duplicate memory files so future sessions can orient faster. All memory files are listed below in full.

## What to do

1. Merge duplicates and overlapping entries into a single stronger memory (save the merged memory, delete the rest).
2. Rewrite vague descriptions so retrieval is easier and more precise.
3. For feedback and project entries, make sure the content is structured as: main rule/fact, **Why:**, **How to apply:**.
4. Delete memories that are clearly obsolete, contradictory, or low-value.
5. Keep the total memory set concise and high signal.

## Guardrails

- Do NOT invent facts.
- If confidence is low, keep the existing memory instead of guessing.
- If memory quality is already strong, change nothing.
- Only touch memories that need it. Unchanged memories must not appear in your reply.

## Reply format

Reply with a single JSON object and nothing else:
{"save": [{"file_name": "...", "name": "...", "description": "...", "type": "user|feedback|project|reference", "content": "..."}], "delete": ["<file_name of a memory to remove>"]}
\`save\` entries create or fully replace the memory with that \`file_name\` (always give the complete content). \`delete\` lists file names exactly as shown. Use {"save": [], "delete": []} when nothing should change.`

export const AUTODREAM_MEMORIES_HEADING = "## Memories"

export function buildAutodreamPrompt(memories: string): string {
  return `${AUTODREAM_PROMPT}\n\n${AUTODREAM_MEMORIES_HEADING}\n\n${memories}`
}
