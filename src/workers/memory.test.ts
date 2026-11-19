import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerSpec } from "../types.ts";
import {
  createMemoryMonitor,
  listProcesses,
  MEMORY_LIMIT_BYTES,
  parseProcStatus,
  parsePs,
  treeRssBytes,
  type MemoryTarget,
  type ProcInfo,
} from "./memory.ts";
import { readRestartLog } from "./restart-log.ts";
import { createSupervisor, type CookieSupervisor } from "./supervisor.ts";

const MB = 1024 * 1024;
const worker = join(import.meta.dir, "fixtures", "memory-worker.ts");

describe("measuring", () => {
  test("a worker's footprint includes every descendant and nothing else", () => {
    const procs: ProcInfo[] = [
      { pid: 10, ppid: 1, rssKb: 100 },
      { pid: 11, ppid: 10, rssKb: 200 },
      { pid: 12, ppid: 11, rssKb: 400 },
      { pid: 20, ppid: 1, rssKb: 1000 },
    ];
    expect(treeRssBytes(procs, 10)).toBe(700 * 1024);
    expect(treeRssBytes(procs, 20)).toBe(1000 * 1024);
    expect(treeRssBytes(procs, 99)).toBe(0);
  });

  test("parses /proc/<pid>/status, treating kernel threads as zero", () => {
    const text = "Name:\tffmpeg\nState:\tS (sleeping)\nPPid:\t42\nVmPeak:\t  900 kB\nVmRSS:\t  12345 kB\nThreads:\t3\n";
    expect(parseProcStatus(7, text)).toEqual({ pid: 7, ppid: 42, rssKb: 12345 });
    expect(parseProcStatus(2, "Name:\tkthreadd\nPPid:\t0\n")).toEqual({ pid: 2, ppid: 0, rssKb: 0 });
    expect(parseProcStatus(3, "garbage")).toBeNull();
  });

  test("parses ps output on macOS and Linux alike", () => {
    expect(parsePs("    1     0  1234\n  501   1 99\nbogus line\n")).toEqual([
      { pid: 1, ppid: 0, rssKb: 1234 },
      { pid: 501, ppid: 1, rssKb: 99 },
    ]);
  });

  test("the real process listing sees this process and a freshly spawned child", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const procs = await listProcesses();
      const self = procs.find((p) => p.pid === process.pid);
      expect(self?.rssKb).toBeGreaterThan(1000);
      expect(procs.find((p) => p.pid === child.pid)?.ppid).toBe(process.pid);
      expect(treeRssBytes(procs, process.pid)).toBeGreaterThan(treeRssBytes(procs, child.pid));
    } finally {
      child.kill();
    }
  });
});

describe("monitor", () => {
  const target = (id: string, pid: number, kind: MemoryTarget["kind"] = "record"): MemoryTarget => ({ id, kind, pid });

  function harness(rssKbByPid: () => Record<number, number>, targets: () => MemoryTarget[]) {
    const exceeded: string[] = [];
    const monitor = createMemoryMonitor({
      targets,
      limitBytes: () => 100 * MB,
      list: async () => Object.entries(rssKbByPid()).map(([pid, rssKb]) => ({ pid: Number(pid), ppid: 1, rssKb })),
      onExceeded: (t) => exceeded.push(t.id),
    });
    return { monitor, exceeded };
  }

  test("only the third consecutive sample over the limit counts", async () => {
    const rss = { 5: 200 * 1024 };
    const { monitor, exceeded } = harness(() => rss, () => [target("a", 5)]);
    await monitor.sample();
    await monitor.sample();
    expect(exceeded).toEqual([]);
    await monitor.sample();
    expect(exceeded).toEqual(["a"]);
  });

  test("a dip below the limit resets the count, so a spike does not kill", async () => {
    const rss: Record<number, number> = { 5: 200 * 1024 };
    const { monitor, exceeded } = harness(() => rss, () => [target("a", 5)]);
    await monitor.sample();
    await monitor.sample();
    rss[5] = 10 * 1024;
    await monitor.sample();
    rss[5] = 200 * 1024;
    await monitor.sample();
    await monitor.sample();
    expect(exceeded).toEqual([]);
    await monitor.sample();
    expect(exceeded).toEqual(["a"]);
  });

  test("a restarted worker (new pid) starts its count again", async () => {
    const rss: Record<number, number> = { 5: 200 * 1024, 6: 200 * 1024 };
    let pid = 5;
    const { monitor, exceeded } = harness(() => rss, () => [target("a", pid)]);
    await monitor.sample();
    await monitor.sample();
    pid = 6;
    await monitor.sample();
    await monitor.sample();
    expect(exceeded).toEqual([]);
    await monitor.sample();
    expect(exceeded).toEqual(["a"]);
  });

  test("each kind has its own fixed limit", () => {
    expect(MEMORY_LIMIT_BYTES.record).toBe(256 * MB);
    expect(MEMORY_LIMIT_BYTES.restream).toBe(512 * MB);
    expect(MEMORY_LIMIT_BYTES.detector).toBe(2048 * MB);
    expect(MEMORY_LIMIT_BYTES.live).toBe(128 * MB);
  });

  test("the main process over its own limit is reported at once", async () => {
    let selfRss = 10 * MB;
    const reports: number[] = [];
    const monitor = createMemoryMonitor({
      targets: () => [],
      self: { limitBytes: 50 * MB, rss: () => selfRss, onExceeded: (b) => reports.push(b) },
      onExceeded: () => {},
    });
    await monitor.sample();
    expect(reports).toEqual([]);
    selfRss = 60 * MB;
    await monitor.sample();
    expect(reports).toEqual([60 * MB]);
  });
});

describe("with a real supervisor", () => {
  const dirs: string[] = [];
  const sups: CookieSupervisor[] = [];
  afterEach(async () => {
    await Promise.all(sups.splice(0).map((s) => s.shutdown()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const spec = (id: string, mb: number, childMb = 0): WorkerSpec => ({
    id,
    kind: "record",
    cmd: [process.execPath, worker, String(mb), String(childMb)],
  });

  test("restarts the worker that eats memory, child processes included, and leaves a normal one alone", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "cookienvr-mem-"));
    dirs.push(logDir);
    const sup = createSupervisor({ logDir, backoffBaseMs: 20, killGraceMs: 300 });
    sups.push(sup);
    sup.apply([spec("normal", 0), spec("hog", 220), spec("childhog", 0, 220)]);
    await sup.ready;

    const monitor = createMemoryMonitor({
      targets: () =>
        sup
          .status()
          .filter((w) => w.pid !== null && w.state !== "backoff")
          .map((w) => ({ id: w.id, kind: w.kind, pid: w.pid as number })),
      limitBytes: () => 150 * MB,
      intervalMs: 60,
      strikes: 3,
      onExceeded: (t) => sup.restart(t.id, "memory"),
    });
    monitor.start();
    try {
      const deadline = Date.now() + 15_000;
      const restarted = (id: string) => sup.status().find((w) => w.id === id)?.lastRestart?.reason === "memory";
      while (!(restarted("hog") && restarted("childhog")) && Date.now() < deadline) await Bun.sleep(50);
      expect(restarted("hog")).toBe(true);
      expect(restarted("childhog")).toBe(true);
      const normal = sup.status().find((w) => w.id === "normal");
      expect(normal?.restarts).toBe(0);
      expect(normal?.state).toBe("running");
      const logged = readRestartLog(logDir, 50).filter((r) => r.reason === "memory").map((r) => r.id);
      expect(new Set(logged)).toEqual(new Set(["hog", "childhog"]));
    } finally {
      monitor.stop();
    }
  }, 25_000);
});
