import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createLogger, getErrorMessage, LOG_SERVICE, MAX_LOG_BYTES } from "../../src/util/log.js"
import { cleanupTempDirs, tempDir } from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("createLogger", () => {
  test("appends JSON lines with the service name, creating the directory", () => {
    const file = join(tempDir(), "state", "plugin.log")
    const log = createLogger(file)
    log("info", "hello", { a: 1 })
    log("warn", "again")
    const lines = readFileSync(file, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ service: LOG_SERVICE, level: "info", message: "hello", a: 1 })
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ level: "warn", message: "again" })
  })

  test("truncates the file once it grows past the limit", () => {
    const file = join(tempDir(), "plugin.log")
    writeFileSync(file, "x".repeat(MAX_LOG_BYTES + 1))
    createLogger(file)("info", "fresh")
    const lines = readFileSync(file, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "").message).toBe("fresh")
    appendFileSync(file, "")
  })

  test("never throws: no file, unwritable path", () => {
    expect(() => createLogger(undefined)("error", "x")).not.toThrow()
    const blocker = join(tempDir(), "file")
    writeFileSync(blocker, "")
    expect(() => createLogger(join(blocker, "nested", "plugin.log"))("error", "x")).not.toThrow()
  })
})

describe("getErrorMessage", () => {
  test("reads Error and message-bearing objects, stringifies the rest", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom")
    expect(getErrorMessage({ message: "obj" })).toBe("obj")
    expect(getErrorMessage(42)).toBe("42")
  })
})
