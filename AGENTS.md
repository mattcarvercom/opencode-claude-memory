# AGENTS.md

OpenCode plugin that replicates Claude Code's persistent memory system. TypeScript on Bun, installed from a clone (`index.js` re-exports `dist/`). Targets OpenCode 2 (`@opencode/plugin`: `Plugin.define`, `setup(ctx)`); the OpenCode 1 build lives on the `opencode-1` branch.

## Structure

```
index.js                          # Root entry OpenCode 2 resolves for a plugin directory (re-exports dist/index.js)
src/
├── index.ts                      # Assembly only: parseConfig(ctx.options) → MemoryStore → coordinators → tool transform, context hook, event loop. Default export { id, setup }.
├── config.ts                     # Plugin options zod schema (strict, `model` per task) + CLAUDE_CONFIG_DIR → MemoryConfig
├── llm.ts                        # ctx.generate.text wrapper, per-task model resolution, deadline, extractJsonObject
├── sdk.ts                        # Local structural types for the V2 SDK shapes the plugin reads (messages, session, events)
├── tools.ts                      # memory_save / delete / list / search / read as JSON-schema tools (codemode: false)
├── store/
│   ├── frontmatter.ts            # THE memory file format: MEMORY_TYPES, parseFrontmatter (30-line limit), buildFrontmatter
│   ├── paths.ts                  # Pure: validateMemoryFileName (sub-paths), sanitizePath, findCanonicalGitRoot, resolveMemoryRoot
│   ├── scan.ts                   # THE scanner: MemoryHeader/MemoryEntry, defaults decided once, manifest, surfaceKey
│   ├── indexFile.ts              # MEMORY.md minimal line-level upsert/remove + truncateEntrypoint
│   └── MemoryStore.ts            # Resolves paths once; list/read/save/delete/search/scan/readIndex; stateDir
├── prompt/
│   ├── sections.ts               # Claude Code prompt text ports (memoryTypes.ts / memdir.ts)
│   └── systemPrompt.ts           # buildMemorySystemPrompt(store, recalled, opts); AUTO_MEMORY_MARKER
├── recall/
│   ├── selector.ts               # One generate.text call that returns {"selected_memories": [...]}
│   ├── format.ts                 # recallSelectedMemories / formatRecalledMemories / truncation / age warning
│   └── RecallCoordinator.ts      # Per-session turn state, prefetch with bounded wait, session-scoped ignore, TTL eviction
├── extraction/
│   ├── prompts.ts                # EXTRACT_PROMPT / AUTODREAM_PROMPT (only copies); both answer with JSON
│   ├── apply.ts                  # Validates the JSON replies and applies them to the store (extraction creates only; dream guards)
│   ├── state.ts                  # extraction-state.json (watermarks, autodream gate), atomic writes, v1 lock migration, posixCksum
│   ├── lock.ts                   # Cross-process maintenance lock: token ownership, heartbeat, reap-lock guarded stale recovery
│   ├── autodream.ts              # Gate + consolidation call + memory-dir backup
│   └── ExtractionCoordinator.ts  # idle events → debounce → serial queue → incremental extraction call; ownership filter; recordSave
├── hooks/
│   ├── messages.ts               # getLastUserQuery / buildTurnID over context-hook messages
│   └── ignore.ts                 # ignore / resume detection, deriveIgnoredFromHistory
└── util/
    ├── log.ts                    # JSON-lines plugin.log in the state dir (V2 has no plugin log channel; stderr is rendered into the chat UI)
    ├── exclusiveFile.ts          # Atomic create-if-absent (tmp + hard link) and the short cross-process file lock
    └── timeout.ts                # withDeadline(): bounded calls with an AbortSignal

test/
├── helpers/index.ts              # temp dirs, makeStore/makeConfig, fake generator/sessions, makeFakeHost (a fake plugin ctx) + makePlugin
├── helpers/processWorker.ts      # real worker processes for the cross-process state/lock tests
├── *.test.ts, store/, recall/, extraction/   # unit + plugin-level tests (bun test)
└── evals/                        # task evals: memory-on vs memory-off system prompts (see test/evals/README.md)
```

## Where to look

| Task | File |
|---|---|
| Add or change a plugin option | `src/config.ts` (schema) → consumers via `MemoryConfig` |
| Which model a background task uses | `src/llm.ts` (`modelForTask`) |
| Add/modify a memory tool | `src/tools.ts` |
| Change the memory file format | `src/store/frontmatter.ts` |
| Path resolution / worktree sharing / file-name rules | `src/store/paths.ts`, `src/store/MemoryStore.ts` |
| `MEMORY.md` editing rules | `src/store/indexFile.ts` |
| What the main agent sees about memory | `src/prompt/systemPrompt.ts`, `src/prompt/sections.ts` |
| Which memories are recalled and when | `src/recall/RecallCoordinator.ts`, `src/recall/selector.ts` |
| Extraction trigger, watermark | `src/extraction/ExtractionCoordinator.ts`, `src/extraction/state.ts` |
| What a model reply may do to the store | `src/extraction/apply.ts` |
| Auto-dream gate / lock / backup | `src/extraction/autodream.ts` |

## Conventions

- **ESM `.js` imports**, `node:` protocol for built-ins.
- **biome** for lint + format (`bun run lint`); `tsconfig.json` covers `src` and `test` with `noUncheckedIndexedAccess`; `tsconfig.build.json` emits `dist/`.
- **No process-level state**: every `Map`/`Set` lives on a coordinator instance created per `setup` call. `grep -rn "^const .* = new \(Map\|Set\)" src/` must stay empty.
- **No environment variables except `CLAUDE_CONFIG_DIR`** (read in `config.ts` only). Tests inject `env` via `createMemoryPlugin(env)` / `parseConfig(options, env)` and never write `process.env` or read the real home.
- **Every SDK call has a deadline** (`util/timeout.ts` `withDeadline`): the SDK disables fetch timeouts, so an unbounded `await ctx.generate.text(...)` or `ctx.session.*` can pin the extraction queue and the maintenance lock forever.
- **No sessions are created.** V2 plugins cannot remove sessions (`ctx.session` has no `remove`/`list`), so background work is stateless `ctx.generate.text`; never create a session for it.
- **Events are server-wide.** `ctx.event.subscribe` delivers every session of every directory; filter through `session.get` (directory, no `parentID`) before acting.
- **State is transactional**: `ExtractionStateStore.update()` runs under a file lock and the mutate callback must decide against the data it is given, never against an earlier snapshot. The maintenance lock is held until the watermark is written.
- **Logging** goes to `<stateDir>/plugin.log` (`util/log.ts`); stderr is rendered into the chat UI.
- **Silent catch blocks** around file I/O are intentional (files may not exist).
- **`@opencode/plugin`** is a peer and dev dependency used for types only (`import type`); the plugin has no runtime import from it. `src/sdk.ts` models only the fields the plugin reads.
- **Tools** are JSON-schema definitions registered in one synchronous `ctx.tool.transform`; `options: { codemode: false }` keeps them direct tool calls instead of moving them behind OpenCode's `execute`.

## Anti-patterns

- **NEVER** touch memory files without `resolveMemoryFilePath()` / `MemoryStore` - path traversal and symlink-escape risk; `MEMORY` is reserved. The scanner walks directories itself and never follows links.
- **NEVER** extract a slice whose trailing assistant message has no `time.completed`, and never advance a watermark backwards (`ExtractionCoordinator.advance` is monotonic).
- **NEVER** rewrite `MEMORY.md` wholesale - use `upsertIndexLine` / `removeIndexLine` (Claude Code formatting must survive).
- **NEVER** let a model reply write files itself or act on it unvalidated: replies are parsed in `extraction/apply.ts`, extraction never overwrites an existing memory, and auto-dream backs the directory up first and refuses to delete more than half of the memories. The transcript is untrusted content.
- **NEVER** assume memory content is fresh - recalled memories carry `ageInDays`.

## Security

- `store/paths.ts`: `validateMemoryFileName()` rejects traversal, absolute paths, dotfiles, null bytes and the reserved name; `resolveMemoryFilePath()` re-checks containment after resolution. `resolveCanonicalRoot()` validates the worktree gitdir → commondir → backlink chain.
- Background model calls have no tools at all: they are `generate.text` calls whose JSON reply is validated by `extraction/apply.ts` (file names go through `MemoryStore`, types are checked, counts are capped).

## Constants

| Constant | Value | Location |
|---|---|---|
| `MAX_MEMORY_FILES` | 200 | `store/paths.ts` |
| `MAX_MEMORY_FILE_BYTES` | 40,000 | `store/paths.ts` |
| `FRONTMATTER_MAX_LINES` | 30 | `store/frontmatter.ts` |
| `MAX_ENTRYPOINT_LINES` / `MAX_ENTRYPOINT_BYTES` | 200 / 25,000 | `store/paths.ts` |
| recall `MAX_MEMORY_LINES` / `MAX_MEMORY_BYTES` | 200 / 4,096 | `recall/format.ts` |
| `SESSION_STATE_TTL_MS` (recall) | 1 h | `recall/RecallCoordinator.ts` |
| `MAX_EXTRACTED_MEMORIES` | 5 | `extraction/apply.ts` |
| `MAX_AUTODREAM_PROMPT_CHARS` / `DREAM_BACKUPS_KEPT` | 150,000 / 3 | `extraction/autodream.ts` |
| `MAX_LOG_BYTES` | 512 KB | `util/log.ts` |
| `MAX_EXTRACTION_FAILURES` | 3 | `extraction/ExtractionCoordinator.ts` |
| `SESSION_STATE_TTL_MS` (extraction state) | 30 d | `extraction/state.ts` |
| `MAINTENANCE_STALE_LOCK_MS` / `MAINTENANCE_HEARTBEAT_MS` | 10 min / 60 s | `extraction/lock.ts` |
| `SDK_READ_TIMEOUT_MS` | 30 s | `extraction/ExtractionCoordinator.ts` |

## Commands

```bash
bun install
bun test                 # all tests incl. test/evals
bun run evals            # task-eval report
bun run lint             # biome ci
bun run typecheck
bun run build            # dist/ via tsconfig.build.json
```

## Notes

- Memory directory: `<CLAUDE_CONFIG_DIR>/projects/<sanitizePath(canonicalGitRoot)>/memory/`, shared with Claude Code. `sanitizePath` / `djb2Hash` are exact copies of Claude Code's.
- Provenance: files this plugin creates carry `metadata.origin: opencode`; edits to other tools' files add `metadata.updatedBy: opencode` and keep every other frontmatter line. Deleting a memory it did not create first copies it to `<stateDir>/trash/<timestamp>/`.
- Plugin state: `<CLAUDE_CONFIG_DIR>/opencode-memory/<same key>/extraction-state.json` (+ `extraction-state.lock` around every update, + `maintenance.lock` shared by extraction and auto-dream across processes) plus `plugin.log`, `trash/` and `dream-backups/`. A v1 `<cksum>.consolidate-lock` is migrated once at start-up.
- A plugin directory is loaded through its root `index.js` (OpenCode 2 resolves `<dir>/server` or `<dir>/index`, not `package.json`); a config path that points at a file is rejected. Config key is `plugins` (entries `"path"` or `{ package, options }`); the old `plugin` key is still read.
- Design history of the plugin's own "v2" (the in-process rewrite, not OpenCode 2) lives in `docs/v2/`.
