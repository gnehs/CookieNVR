import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRestart, pruneRestartLog, readRestartLog, type RestartRecord } from "./restart-log.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12);
let dir = "";

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rec(at: number, id: string): RestartRecord {
  return { at, id, kind: "record", reason: "exit", exitCode: 1, signal: null, backoffMs: 2000, stderrTail: [] };
}

test("reads the newest N records across day files, newest first", () => {
  dir = mkdtempSync(join(tmpdir(), "cookienvr-log-"));
  appendRestart(dir, rec(NOW - 2 * DAY, "a"));
  appendRestart(dir, rec(NOW - DAY, "b"));
  appendRestart(dir, rec(NOW, "c"));
  appendRestart(dir, rec(NOW + 1, "d"));
  expect(readRestartLog(dir, 3).map((r) => r.id)).toEqual(["d", "c", "b"]);
  expect(readRestartLog(dir, 100).map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
});

test("skips a line torn by a crash", () => {
  dir = mkdtempSync(join(tmpdir(), "cookienvr-log-"));
  appendRestart(dir, rec(NOW, "a"));
  appendFileSync(join(dir, readdirSync(dir)[0]!), '{"at":');
  expect(readRestartLog(dir, 10).map((r) => r.id)).toEqual(["a"]);
});

test("prune deletes only days entirely older than 30 days", () => {
  dir = mkdtempSync(join(tmpdir(), "cookienvr-log-"));
  appendRestart(dir, rec(NOW - 40 * DAY, "old"));
  appendRestart(dir, rec(NOW - 31 * DAY, "edge"));
  appendRestart(dir, rec(NOW - 29 * DAY, "recent"));
  expect(pruneRestartLog(dir, { now: NOW })).toBe(2);
  expect(readRestartLog(dir, 10).map((r) => r.id)).toEqual(["recent"]);
  expect(pruneRestartLog(dir, { now: NOW })).toBe(0);
});

test("missing directory reads as empty", () => {
  dir = join(tmpdir(), "cookienvr-log-missing");
  expect(readRestartLog(dir, 10)).toEqual([]);
  expect(pruneRestartLog(dir)).toBe(0);
});
