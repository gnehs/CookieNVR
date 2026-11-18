import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RestartReason, WorkerKind } from "../types.ts";

export interface RestartRecord {
  at: number;
  id: string;
  kind: WorkerKind;
  reason: RestartReason;
  exitCode: number | null;
  signal: string | null;
  /** Delay before the next start; 0 = immediate. */
  backoffMs: number;
  stderrTail: string[];
}

const DAY_MS = 86_400_000;
const FILE_RE = /^restarts-(\d{4})(\d{2})(\d{2})\.jsonl$/;

// One file per UTC day, so pruning deletes whole files instead of rewriting one.
function fileName(at: number): string {
  return `restarts-${new Date(at).toISOString().slice(0, 10).replaceAll("-", "")}.jsonl`;
}

function logFiles(dir: string): { name: string; dayStart: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const m = FILE_RE.exec(name);
      return m ? [{ name, dayStart: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) }] : [];
    })
    .sort((a, b) => b.dayStart - a.dayStart);
}

export function appendRestart(dir: string, record: RestartRecord): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, fileName(record.at)), `${JSON.stringify(record)}\n`);
}

/** Newest first. */
export function readRestartLog(dir: string, limit: number): RestartRecord[] {
  const out: RestartRecord[] = [];
  for (const { name } of logFiles(dir)) {
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as RestartRecord);
      } catch {
        // A line torn by a crash mid-append.
      }
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Deletes day files whose every record is older than maxAgeMs. Returns the number of files removed. */
export function pruneRestartLog(dir: string, opts: { now?: number; maxAgeMs?: number } = {}): number {
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? 30 * DAY_MS);
  const stale = logFiles(dir).filter((f) => f.dayStart + DAY_MS <= cutoff);
  for (const f of stale) rmSync(join(dir, f.name), { force: true });
  return stale.length;
}
