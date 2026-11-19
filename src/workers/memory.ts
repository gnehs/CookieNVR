import { readFile, readdir } from "node:fs/promises";
import type { WorkerKind } from "../types.ts";

const MB = 1024 * 1024;

/** Fixed per-kind limits from the spec's worker table; there is deliberately no setting for them. */
export const MEMORY_LIMIT_BYTES: Record<WorkerKind, number> = {
  restream: 512 * MB,
  record: 256 * MB,
  detect: 384 * MB,
  detector: 2048 * MB,
  classifier: 1024 * MB,
  live: 128 * MB,
  homekit: 256 * MB,
  "hksv-stream": 256 * MB,
  export: 256 * MB,
};

export const SAMPLE_INTERVAL_MS = 5_000;
/** Consecutive samples over the limit before a worker counts as overloaded. */
export const STRIKES_TO_RESTART = 3;

export interface ProcInfo {
  pid: number;
  ppid: number;
  rssKb: number;
}

export type ProcessLister = () => Promise<ProcInfo[]>;

/** Resident memory of `rootPid` plus all of its descendants. */
export function treeRssBytes(procs: readonly ProcInfo[], rootPid: number): number {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let kb = byPid.get(rootPid)?.rssKb ?? 0;
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      kb += child.rssKb;
      queue.push(child.pid);
    }
  }
  return kb * 1024;
}

/** One `/proc/<pid>/status` file; kernel threads have no VmRSS line and count as 0. */
export function parseProcStatus(pid: number, text: string): ProcInfo | null {
  const ppid = /^PPid:\s*(\d+)/m.exec(text)?.[1];
  if (ppid === undefined) return null;
  const rss = /^VmRSS:\s*(\d+)\s*kB/m.exec(text)?.[1];
  return { pid, ppid: Number(ppid), rssKb: rss === undefined ? 0 : Number(rss) };
}

/** Output of `ps -A -o pid=,ppid=,rss=` (rss in KB on both macOS and Linux). */
export function parsePs(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]) });
  }
  return out;
}

async function listFromProc(): Promise<ProcInfo[]> {
  const names = (await readdir("/proc")).filter((n) => /^\d+$/.test(n));
  const read = await Promise.all(
    names.map(async (n) => {
      try {
        return parseProcStatus(Number(n), await readFile(`/proc/${n}/status`, "utf8"));
      } catch {
        return null; // the process exited between readdir and read
      }
    }),
  );
  return read.filter((p): p is ProcInfo => p !== null);
}

async function listFromPs(): Promise<ProcInfo[]> {
  const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,rss="], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("ps failed");
  return parsePs(text);
}

/** Linux reads `/proc` (no fork per sample); other platforms, macOS in development, use `ps`. */
export const listProcesses: ProcessLister = () => (process.platform === "linux" ? listFromProc() : listFromPs());

export interface MemoryTarget {
  id: string;
  kind: WorkerKind;
  pid: number;
}

export interface MemoryMonitorOptions {
  /** Currently running processes to watch; called on every sample. */
  targets: () => MemoryTarget[];
  /** Called after STRIKES consecutive samples over the kind's limit. */
  onExceeded: (target: MemoryTarget, rssBytes: number) => void;
  /** The main process itself: over the limit on a single sample is fatal. */
  self?: { limitBytes: number; rss: () => number; onExceeded: (rssBytes: number) => void };
  limitBytes?: (kind: WorkerKind) => number;
  list?: ProcessLister;
  intervalMs?: number;
  strikes?: number;
  onError?: (error: unknown) => void;
}

export interface MemoryMonitor {
  /** One sampling pass; the interval timer calls this. */
  sample(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createMemoryMonitor(opts: MemoryMonitorOptions): MemoryMonitor {
  const limitOf = opts.limitBytes ?? ((kind: WorkerKind) => MEMORY_LIMIT_BYTES[kind]);
  const list = opts.list ?? listProcesses;
  const strikes = opts.strikes ?? STRIKES_TO_RESTART;
  /** Keyed by worker id; a new pid means the worker restarted, so earlier strikes no longer apply. */
  const over = new Map<string, { pid: number; count: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function sample(): Promise<void> {
    if (opts.self) {
      const rss = opts.self.rss();
      if (rss > opts.self.limitBytes) {
        opts.self.onExceeded(rss);
        return;
      }
    }
    const targets = opts.targets();
    if (targets.length === 0) {
      over.clear();
      return;
    }
    const procs = await list();
    const live = new Set<string>();
    for (const target of targets) {
      live.add(target.id);
      const rss = treeRssBytes(procs, target.pid);
      if (rss <= limitOf(target.kind)) {
        over.delete(target.id);
        continue;
      }
      const prev = over.get(target.id);
      const count = prev?.pid === target.pid ? prev.count + 1 : 1;
      if (count < strikes) {
        over.set(target.id, { pid: target.pid, count });
        continue;
      }
      over.delete(target.id);
      opts.onExceeded(target, rss);
    }
    for (const id of over.keys()) if (!live.has(id)) over.delete(id);
  }

  return {
    sample,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        sample()
          .catch((e) => opts.onError?.(e))
          .finally(() => (running = false));
      }, opts.intervalMs ?? SAMPLE_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
