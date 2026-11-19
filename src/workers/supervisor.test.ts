import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerSpec, WorkerStatus } from "../types.ts";
import { processStartToken, readPidFile, writePidFile } from "./process-group.ts";
import { readRestartLog } from "./restart-log.ts";
import { createSupervisor, type CookieSupervisor, type SupervisorOptions } from "./supervisor.ts";

const dirs: string[] = [];
const sups: CookieSupervisor[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cookienvr-sup-"));
  dirs.push(d);
  return d;
}

function makeSupervisor(opts: Partial<SupervisorOptions> = {}): { sup: CookieSupervisor; logDir: string } {
  const logDir = opts.logDir ?? tempDir();
  const sup = createSupervisor({
    backoffBaseMs: 50,
    backoffMaxMs: 400,
    backoffResetMs: 60_000,
    killGraceMs: 300,
    ...opts,
    logDir,
  });
  sups.push(sup);
  return { sup, logDir };
}

afterEach(async () => {
  await Promise.all(sups.splice(0).map((s) => s.shutdown()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(id: string, script: string, extra: Partial<WorkerSpec> = {}): WorkerSpec {
  return { id, kind: "record", cmd: ["sh", "-c", script], ...extra };
}

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

function one(sup: CookieSupervisor, id: string): WorkerStatus | undefined {
  return sup.status().find((s) => s.id === id);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads `child=<pid>` lines a worker prints for its own background children. */
function childPids(s: WorkerStatus): number[] {
  return s.stderrTail.flatMap((l) => (l.startsWith("child=") ? [Number(l.slice(6))] : []));
}

describe("apply", () => {
  test("starts missing workers and is a no-op for an identical list", async () => {
    const { sup } = makeSupervisor();
    const events: WorkerStatus[] = [];
    sup.subscribe((s) => events.push(s));
    const specs = [sh("a", "sleep 30"), sh("b", "sleep 30")];
    sup.apply(specs);
    const a = await until(() => one(sup, "a")?.state === "running" && one(sup, "a"));
    await until(() => one(sup, "b")?.state === "running");
    const seen = events.length;

    sup.apply(specs.map((s) => ({ ...s, cmd: [...s.cmd] })));
    await Bun.sleep(100);
    expect(events.length).toBe(seen);
    expect(one(sup, "a")?.pid).toBe(a.pid);
    expect(one(sup, "a")?.restarts).toBe(0);
  });

  test("restarts on cmd/env/cwd change with reason spec-changed, immediately", async () => {
    const { sup, logDir } = makeSupervisor();
    sup.apply([sh("a", "sleep 30", { env: { X: "1" } })]);
    const first = await until(() => one(sup, "a")?.state === "running" && one(sup, "a"));

    sup.apply([sh("a", "sleep 30", { env: { X: "2" } })]);
    const second = await until(() => {
      const s = one(sup, "a");
      return s?.state === "running" && s.pid !== first.pid && s;
    });
    expect(alive(first.pid!)).toBe(false);
    expect(second.lastRestart?.reason).toBe("spec-changed");
    expect(readRestartLog(logDir, 10).map((r) => [r.id, r.reason, r.backoffMs])).toEqual([["a", "spec-changed", 0]]);

    sup.apply([sh("a", "sleep 30", { env: { X: "2" }, cwd: tmpdir() })]);
    await until(() => one(sup, "a")?.restarts === 2 && one(sup, "a")?.state === "running");
  });

  test("swaps in a new stall function without restarting", async () => {
    const { sup } = makeSupervisor();
    let calls = { old: 0, new: 0 };
    const spec = (key: "old" | "new"): WorkerSpec =>
      sh("a", "sleep 30", { stall: { graceMs: 0, intervalMs: 20, healthy: () => (calls[key]++, true) } });
    sup.apply([spec("old")]);
    const first = await until(() => one(sup, "a")?.state === "running" && one(sup, "a"));
    sup.apply([spec("new")]);
    calls = { old: 0, new: 0 };
    await Bun.sleep(150);
    expect(calls.old).toBe(0);
    expect(calls.new).toBeGreaterThan(2);
    expect(one(sup, "a")?.pid).toBe(first.pid);
  });

  test("stops workers that are no longer listed", async () => {
    const { sup } = makeSupervisor();
    sup.apply([sh("a", "sleep 30"), sh("b", "sleep 30")]);
    const b = await until(() => one(sup, "b")?.state === "running" && one(sup, "b"));
    sup.apply([sh("a", "sleep 30")]);
    await until(() => !one(sup, "b"));
    expect(alive(b.pid!)).toBe(false);
    expect(one(sup, "a")?.state).toBe("running");
  });

  test("rejects duplicate ids", () => {
    const { sup } = makeSupervisor();
    expect(() => sup.apply([sh("a", "sleep 1"), sh("a", "sleep 1")])).toThrow("duplicate");
  });
});

describe("restart policy", () => {
  test("crashing worker backs off exponentially up to the max and logs each restart", async () => {
    const { sup, logDir } = makeSupervisor();
    sup.apply([sh("a", "echo boom >&2; exit 3")]);
    await until(() => (one(sup, "a")?.restarts ?? 0) >= 5, 5_000);
    const log = readRestartLog(logDir, 5).reverse();
    expect(log.map((r) => r.backoffMs)).toEqual([50, 100, 200, 400, 400]);
    expect(log.every((r) => r.reason === "exit" && r.exitCode === 3)).toBe(true);
    expect(log[0]?.stderrTail).toContain("boom");
    expect(one(sup, "a")?.lastRestart).toMatchObject({ reason: "exit", exitCode: 3 });
  });

  test("a run that lasted the reset period starts the backoff over", async () => {
    const { sup, logDir } = makeSupervisor({ backoffResetMs: 100 });
    sup.apply([sh("a", "sleep 0.15; exit 1")]);
    await until(() => (one(sup, "a")?.restarts ?? 0) >= 3, 5_000);
    expect(readRestartLog(logDir, 3).map((r) => r.backoffMs)).toEqual([50, 50, 50]);
  });

  test("worker that exits cleanly is restarted too", async () => {
    const { sup } = makeSupervisor();
    sup.apply([sh("a", "exit 0")]);
    const s = await until(() => (one(sup, "a")?.restarts ?? 0) >= 2 && one(sup, "a"));
    expect(s.lastRestart).toMatchObject({ reason: "exit", exitCode: 0 });
  });

  test("marks unstable past the threshold but keeps retrying", async () => {
    const { sup } = makeSupervisor({ backoffBaseMs: 5, backoffMaxMs: 5, unstableThreshold: 3 });
    const unstableAt = new Map<number, boolean>();
    sup.subscribe((s) => unstableAt.set(s.restarts, s.unstable));
    sup.apply([sh("a", "exit 1")]);
    await until(() => (one(sup, "a")?.restarts ?? 0) >= 8);
    expect([unstableAt.get(3), unstableAt.get(4), unstableAt.get(8)]).toEqual([false, true, true]);
  });

  test("manual restart is immediate and does not count as a failure", async () => {
    const { sup, logDir } = makeSupervisor({ unstableThreshold: 0 });
    sup.apply([sh("a", "sleep 30")]);
    const first = await until(() => one(sup, "a")?.state === "running" && one(sup, "a"));
    sup.restart("a");
    const s = await until(() => one(sup, "a")?.state === "running" && one(sup, "a")?.pid !== first.pid && one(sup, "a"));
    expect(s.unstable).toBe(false);
    expect(readRestartLog(logDir, 1)[0]).toMatchObject({ reason: "manual", backoffMs: 0 });
    expect(() => sup.restart("nope")).toThrow("unknown worker");
  });

  test("memory reason restarts immediately and counts as a failure", async () => {
    const { sup, logDir } = makeSupervisor({ unstableThreshold: 0 });
    sup.apply([sh("a", "sleep 30")]);
    await until(() => one(sup, "a")?.state === "running");
    sup.restart("a", "memory");
    const s = await until(() => one(sup, "a")?.restarts === 1 && one(sup, "a")?.state === "running" && one(sup, "a"));
    expect(s.unstable).toBe(true);
    expect(readRestartLog(logDir, 1)[0]).toMatchObject({ reason: "memory", backoffMs: 0 });
  });
});

describe("stall detection", () => {
  test("stays starting through the grace period, then running while healthy", async () => {
    const { sup } = makeSupervisor();
    sup.apply([sh("a", "sleep 30", { stall: { graceMs: 150, intervalMs: 20, healthy: () => true } })]);
    await until(() => one(sup, "a")?.state === "starting");
    await Bun.sleep(80);
    expect(one(sup, "a")?.state).toBe("starting");
    await until(() => one(sup, "a")?.state === "running");
  });

  for (const [label, healthy] of [
    ["returns false", () => false],
    ["throws", () => {
      throw new Error("probe down");
    }],
    ["never settles", () => new Promise<boolean>(() => {})],
  ] as const) {
    test(`restarts with reason stall when healthy() ${label}`, async () => {
      const { sup, logDir } = makeSupervisor();
      sup.apply([sh("a", "sleep 30", { stall: { graceMs: 30, intervalMs: 30, healthy } })]);
      const first = await until(() => (one(sup, "a")?.pid ?? 0) > 0 && one(sup, "a"));
      await until(() => one(sup, "a")?.lastRestart?.reason === "stall");
      expect(alive(first.pid!)).toBe(false);
      expect(readRestartLog(logDir, 1)[0]).toMatchObject({ reason: "stall", backoffMs: 50 });
    });
  }
});

describe("stopping", () => {
  test("kills the whole process tree, not just the leader", async () => {
    const { sup } = makeSupervisor();
    sup.apply([sh("a", "sleep 30 & echo child=$!; sh -c 'sleep 30 & echo child=$!; wait' & wait")]);
    const s = await until(() => {
      const st = one(sup, "a");
      return st && childPids(st).length === 2 && st;
    });
    const pids = [s.pid!, ...childPids(s)];
    expect(pids.every(alive)).toBe(true);
    sup.apply([]);
    await until(() => !one(sup, "a"));
    expect(pids.filter(alive)).toEqual([]);
  });

  test("reaps descendants left behind when the leader exits by itself", async () => {
    const { sup } = makeSupervisor();
    sup.apply([sh("a", "sleep 30 & echo child=$!; sleep 0.2; exit 1")]);
    const s = await until(() => {
      const st = one(sup, "a");
      return st && childPids(st).length === 1 && st;
    });
    const [child] = childPids(s);
    await until(() => (one(sup, "a")?.restarts ?? 0) >= 1);
    expect(alive(child!)).toBe(false);
  });

  test("escalates to SIGKILL after the grace period", async () => {
    const { sup } = makeSupervisor({ killGraceMs: 200 });
    sup.apply([sh("a", "trap '' TERM; echo ready; while :; do sleep 0.02; done")]);
    const s = await until(() => one(sup, "a")?.stderrTail.includes("ready") && one(sup, "a"));
    const t0 = Date.now();
    sup.apply([]);
    await until(() => !one(sup, "a"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
    expect(alive(s.pid!)).toBe(false);
  });

  test("shutdown stops everything and resolves after the processes are gone", async () => {
    const { sup } = makeSupervisor();
    sup.apply([sh("a", "sleep 30"), sh("b", "exit 1"), sh("c", "trap '' TERM; while :; do sleep 0.02; done")]);
    await until(() => one(sup, "a")?.state === "running" && one(sup, "c")?.state === "running");
    const pids = sup.status().flatMap((s) => (s.pid ? [s.pid] : []));
    await sup.shutdown();
    expect(pids.filter(alive)).toEqual([]);
    expect(sup.status()).toEqual([]);
    sup.apply([sh("a", "sleep 30")]);
    expect(sup.status()).toEqual([]);
  });

  test("subscribe reports each transition and unsubscribe stops it", async () => {
    const { sup } = makeSupervisor();
    const states: string[] = [];
    const off = sup.subscribe((s) => states.push(s.state));
    sup.apply([sh("a", "sleep 30")]);
    await until(() => one(sup, "a")?.state === "running");
    sup.apply([]);
    await until(() => !one(sup, "a"));
    expect(states).toEqual(["running", "stopped", "stopped"]);
    off();
    sup.apply([sh("a", "sleep 30")]);
    await until(() => one(sup, "a"));
    expect(states.length).toBe(3);
  });
});

describe("orphans from a killed main process", () => {
  test("a new supervisor reaps workers whose parent was SIGKILLed", async () => {
    const logDir = tempDir();
    const parent = Bun.spawn(
      ["bun", join(import.meta.dir, "fixtures/orphan-parent.ts"), logDir, `sleep 30 & echo $! > ${logDir}/child; wait`],
      { stdout: "ignore", stderr: "inherit" },
    );
    const leader = await until(() => readPidFile(join(logDir, "workers.pid.json"))[0]?.pid, 5_000);
    const child = await until(() => {
      try {
        return Number(readFileSync(join(logDir, "child"), "utf8")) || undefined;
      } catch {
        return undefined;
      }
    });
    parent.kill("SIGKILL");
    await parent.exited;
    expect(alive(leader) && alive(child)).toBe(true);

    const { sup } = makeSupervisor({ logDir });
    await sup.ready;
    expect(alive(leader)).toBe(false);
    expect(alive(child)).toBe(false);
  });

  test("does not touch an unrelated process that reuses a recorded pid", async () => {
    const logDir = tempDir();
    const bystander = Bun.spawn(["sleep", "30"]);
    try {
      writePidFile(join(logDir, "workers.pid.json"), [
        { id: "stale", pid: bystander.pid, startToken: "not-the-real-start-time" },
        { id: "self", pid: process.pid, startToken: processStartToken(process.pid)! },
      ]);
      const { sup } = makeSupervisor({ logDir });
      await sup.ready;
      expect(alive(bystander.pid)).toBe(true);
      expect(readPidFile(join(logDir, "workers.pid.json"))).toEqual([]);
    } finally {
      bystander.kill("SIGKILL");
    }
  });

  test("workers listed before reaping finishes start afterwards", async () => {
    const { sup } = makeSupervisor();
    sup.apply([sh("a", "sleep 30")]);
    await sup.ready;
    await until(() => one(sup, "a")?.state === "running");
  });
});

describe("stdout as data", () => {
  test("each run's stdout goes to readStdout and stays out of the tail", async () => {
    const { sup } = makeSupervisor();
    const runs: string[] = [];
    sup.apply([
      sh("a", "printf 'frame-bytes'; echo log-line >&2; sleep 0.1", {
        readStdout: async (stdout) => {
          runs.push(await new Response(stdout).text());
        },
      }),
    ]);
    await until(() => runs.length >= 2);
    expect(runs.slice(0, 2)).toEqual(["frame-bytes", "frame-bytes"]);
    const tail = one(sup, "a")!.stderrTail;
    expect(tail).toContain("log-line");
    expect(tail.some((l) => l.includes("frame-bytes"))).toBe(false);
  });
});
