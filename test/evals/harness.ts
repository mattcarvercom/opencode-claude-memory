import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContextMessage } from "../../src/sdk.js"
import { MemoryStore } from "../../src/store/MemoryStore.js"
import { makePlugin, selectionReply } from "../helpers/index.js"
import type { EvalMessage, SeedMemory, TaskEvalCase } from "./fixtures.js"
import type { TaskEvalJudge, TaskEvalJudgeResult } from "./judges.js"

export type TaskEvalResult = TaskEvalJudgeResult & {
  caseID: string
  description: string
  onPrompt: string
  offPrompt: string
}

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "task-eval-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  return root
}

let messageSeq = 0

// Only user and assistant text reaches the V2 `context` hook as plain text parts; the fixtures'
// system and tool parts have no counterpart there and are dropped.
function materializeMessages(messages: EvalMessage[]): ContextMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      messageSeq += 1
      return {
        id: `eval_${messageSeq}`,
        role: message.role,
        content: message.parts.filter((part) => part.type === "text").map((part) => ({ ...part })),
      }
    })
}

function memoryFileName(memory: SeedMemory): string {
  return memory.fileName.endsWith(".md") ? memory.fileName : `${memory.fileName}.md`
}

function inferSelectorFilenames(taskCase: TaskEvalCase): string[] {
  const positiveNeedles = taskCase.checks.onContains ?? []
  const negativeNeedles = taskCase.checks.onNotContains ?? []

  return taskCase.memories
    .filter((memory) => {
      const positive = positiveNeedles.some((needle) => memory.content.includes(needle))
      const negative = negativeNeedles.some((needle) => memory.content.includes(needle))
      return positive && !negative
    })
    .map(memoryFileName)
    .slice(0, 5)
}

async function makeHost(repo: string, claudeConfigDir: string, taskCase: TaskEvalCase) {
  const host = await makePlugin({
    directory: repo,
    claudeConfigDir,
    options: { extract: { enabled: false }, autodream: { enabled: false } },
  })
  host.setGenerate(() => selectionReply(...inferSelectorFilenames(taskCase)))
  return host
}

// memory-on: the case messages as-is. memory-off: the same session first asked to ignore memory,
// which is how a user turns memory off (session-scoped, no environment variable).
async function renderSystemPrompt(
  host: Awaited<ReturnType<typeof makeHost>>,
  messages: EvalMessage[],
  sessionID: string,
  ignoreMemory: boolean,
): Promise<string> {
  const prelude: EvalMessage[] = ignoreMemory
    ? [{ role: "user", parts: [{ type: "text", text: "Ignore memory for this whole session." }] }]
    : []
  if (prelude.length > 0) {
    // Turn 1: the user switches memory off for the session.
    await host.runContext(sessionID, materializeMessages(prelude))
  }
  // Turn 2 (or the only turn): the case conversation.
  const system = await host.runContext(sessionID, materializeMessages([...prelude, ...messages]))
  return system.join("\n\n")
}

export async function runTaskEvalCase(taskCase: TaskEvalCase, judge: TaskEvalJudge): Promise<TaskEvalResult> {
  const repo = makeTempGitRepo()
  const claudeConfigDir = join(repo, ".claude-test")

  try {
    const store = new MemoryStore(repo, { claudeConfigDir })
    for (const memory of taskCase.memories) {
      const { filePath } = store.save({
        fileName: memory.fileName,
        name: memory.name,
        description: memory.description,
        type: memory.type,
        content: memory.content,
      })
      if (memory.mtime) {
        const mtime = new Date(memory.mtime)
        utimesSync(filePath, mtime, mtime)
      }
    }

    const host = await makeHost(repo, claudeConfigDir, taskCase)
    const onPrompt = await renderSystemPrompt(host, taskCase.messages, `${taskCase.id}:on`, false)
    const offPrompt = await renderSystemPrompt(host, taskCase.messages, `${taskCase.id}:off`, true)
    host.cleanup()
    const judged = await judge({ taskCase, onPrompt, offPrompt })

    return {
      caseID: taskCase.id,
      description: taskCase.description,
      onPrompt,
      offPrompt,
      passed: judged.passed,
      failures: judged.failures,
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

export async function runTaskEvalSuite(
  taskCases: readonly TaskEvalCase[],
  judge: TaskEvalJudge,
): Promise<TaskEvalResult[]> {
  const results: TaskEvalResult[] = []
  for (const taskCase of taskCases) {
    results.push(await runTaskEvalCase(taskCase, judge))
  }
  return results
}
