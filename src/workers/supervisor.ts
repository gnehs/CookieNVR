import { join } from "node:path";
import type { Subprocess } from "bun";
import type {
  RestartReason,
  Supervisor,
  Unsubscribe,
  WorkerSpec,
  WorkerState,
  WorkerStatus,
} from "../types.ts";
import {
  processStartToken,
  reapOrphans,
  signalGroup,
  waitGroupGone,
  writePidFile,
  type PidEntry,
} from "./process-group.ts";
import { appendRestart } from "./restart-log.ts";

export interface SupervisorOptions {
  /** Restart JSONL files go here. */
  logDir: string;
  /** Live worker pids, read on the next start to reap orphans. Default `<logDir>/workers.pid.json`. */
  pidFile?: string;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A run lasting at least this long resets the backoff streak. */
  backoffResetMs?: number;
  /** Time between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  unstableWindowMs?: number;
  /** unstable = more than this many failure restarts inside the window. */
  unstableThreshold?: number;
  tailLines?: number;
  now?: () => number;
}

/**
 * What each restart reason means for recovery. Failures count toward backoff and
 * instability; operator- or config-driven restarts come back at once.
 */
const RESTART_POLICY: Record<RestartReason, { failure: boolean; backoff: boolean }> = {
  exit: { failure: true, backoff: true },
  stall: { failure: true, backoff: true },
  // The spec restarts an over-limit worker immediately; repeats still mark it unstable.
  memory: { failure: true, backoff: false },
  manual: { failure: false, backoff: false },
  "spec-changed": { failure: false, backoff: false },
};

type Timer = ReturnType<typeof setTimeout>;

interface Run {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  pid: number;
  startedAt: number;
  output: Promise<void>;
  stallTimer: Timer | null;
  killTimer: Timer | null;
}

type StopIntent = RestartReason | "remove";

type Phase =
  /** Created by apply, spawned within the same call. */
  | { tag: "pending" }
  /** `confirmed` turns true on the first passing stall check (or at once without one). */
  | { tag: "running"; run: Run; confirmed: boolean }
  | { tag: "stopping"; run: Run; intent: StopIntent }
  | { tag: "backoff"; timer: Timer; until: number };

interface Worker {
  /** Latest desired spec; a run keeps using the cmd/env/cwd it was spawned with. */
  spec: WorkerSpec;
  phase: Phase;
  restarts: number;
  failureStreak: number;
  failureTimes: number[];
  lastRestart: WorkerStatus["lastRestart"];
  tail: string[];
}

export interface CookieSupervisor extends Supervisor {
  /** Resolves once orphans from a previous main process are reaped and workers may start. */
  readonly ready: Promise<void>;
}

export function createSupervisor(opts: SupervisorOptions): CookieSupervisor {
  const cfg = {
    pidFile: opts.pidFile ?? join(opts.logDir, "workers.pid.json"),
    backoffBaseMs: opts.backoffBaseMs ?? 2_000,
    backoffMaxMs: opts.backoffMaxMs ?? 30_000,
    backoffResetMs: opts.backoffResetMs ?? 60_000,
    killGraceMs: opts.killGraceMs ?? 5_000,
    unstableWindowMs: opts.unstableWindowMs ?? 10 * 60_000,
    unstableThreshold: opts.unstableThreshold ?? 10,
    tailLines: opts.tailLines ?? 50,
    now: opts.now ?? Date.now,
  };

  const workers = new Map<string, Worker>();
  const listeners = new Set<(s: WorkerStatus) => void>();
  const runEnded = new Set<Promise<void>>();
  let desired: WorkerSpec[] | null = null;
  let isReady = false;
  let closed = false;

  const ready = reapOrphans(cfg.pidFile, cfg.killGraceMs).then(
    () => undefined,
    () => undefined,
  );
  void ready.then(() => {
    isReady = true;
    if (desired && !closed) reconcile(desired);
  });

  function stateOf(phase: Phase): WorkerState {
    switch (phase.tag) {
      case "pending":
        return "starting";
      case "running":
        return phase.confirmed ? "running" : "starting";
      case "stopping":
        return phase.intent === "remove" ? "stopped" : "backoff";
      case "backoff":
        return "backoff";
    }
  }

  function unstable(w: Worker): boolean {
    const since = cfg.now() - cfg.unstableWindowMs;
    return w.failureTimes.filter((t) => t >= since).length > cfg.unstableThreshold;
  }

  function snapshot(w: Worker): WorkerStatus {
    const run = w.phase.tag === "running" || w.phase.tag === "stopping" ? w.phase.run : null;
    return {
      id: w.spec.id,
      kind: w.spec.kind,
      state: stateOf(w.phase),
      unstable: unstable(w),
      pid: run?.pid ?? null,
      startedAt: run?.startedAt ?? null,
      restarts: w.restarts,
      lastRestart: w.lastRestart,
      stderrTail: [...w.tail],
    };
  }

  function notify(status: WorkerStatus): void {
    for (const l of listeners) {
      try {
        l(status);
      } catch {
        // A broken listener must not stall supervision.
      }
    }
  }

  function setPhase(w: Worker, phase: Phase): void {
    w.phase = phase;
    notify(snapshot(w));
  }

  function persistPids(): void {
    const entries: PidEntry[] = [];
    for (const w of workers.values()) {
      if (w.phase.tag !== "running" && w.phase.tag !== "stopping") continue;
      const startToken = processStartToken(w.phase.run.pid);
      if (startToken) entries.push({ id: w.spec.id, pid: w.phase.run.pid, startToken });
    }
    writePidFile(cfg.pidFile, entries);
  }

  function pushTail(w: Worker, line: string): void {
    w.tail.push(line);
    if (w.tail.length > cfg.tailLines) w.tail.splice(0, w.tail.length - cfg.tailLines);
  }

  async function pumpLines(w: Worker, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let partial = "";
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // ffmpeg rewrites its progress line with bare \r.
        const parts = (partial + decoder.decode(value, { stream: true })).split(/\r\n|\r|\n/);
        partial = (parts.pop() ?? "").slice(-4096);
        for (const p of parts) if (p) pushTail(w, p);
      }
    } catch {
      // Stream torn down with the process.
    }
    if (partial) pushTail(w, partial);
  }

  function isCurrent(w: Worker, run: Run): boolean {
    return (
      workers.get(w.spec.id) === w &&
      (w.phase.tag === "running" || w.phase.tag === "stopping") &&
      w.phase.run === run
    );
  }

  function start(w: Worker): void {
    const { cmd, env, cwd } = w.spec;
    let proc: Run["proc"];
    try {
      proc = Bun.spawn(cmd, {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      pushTail(w, `[supervisor] spawn failed: ${(e as Error).message}`);
      afterRun(w, "exit", null, null, cfg.now());
      return;
    }
    const { readStdout } = w.spec;
    const stdout = readStdout
      ? readStdout(proc.stdout).catch((e) => pushTail(w, `[supervisor] stdout reader failed: ${(e as Error).message}`))
      : pumpLines(w, proc.stdout);
    const run: Run = {
      proc,
      pid: proc.pid,
      startedAt: cfg.now(),
      // MediaMTX logs to stdout, ffmpeg to stderr; both feed the same tail unless stdout carries data.
      output: Promise.all([stdout, pumpLines(w, proc.stderr)]).then(() => undefined),
      stallTimer: null,
      killTimer: null,
    };
    setPhase(w, { tag: "running", run, confirmed: !w.spec.stall });
    persistPids();
    if (w.spec.stall) scheduleStallCheck(w, run, w.spec.stall.graceMs);
    const ended = watch(w, run);
    runEnded.add(ended);
    void ended.finally(() => runEnded.delete(ended));
  }

  async function watch(w: Worker, run: Run): Promise<void> {
    const exitCode = await run.proc.exited;
    if (isCurrent(w, run) && w.phase.tag === "running") {
      setPhase(w, { tag: "stopping", run, intent: "exit" });
      signalTerm(run);
    }
    if (!(await waitGroupGone(run.pid, cfg.killGraceMs + 2_000))) {
      // Typically unreaped zombies when nothing in the container acts as init.
      pushTail(w, `[supervisor] process group ${run.pid} still present after SIGKILL`);
    }
    if (run.killTimer) clearTimeout(run.killTimer);
    if (run.stallTimer) clearTimeout(run.stallTimer);
    await Promise.race([run.output, Bun.sleep(500)]);
    if (!isCurrent(w, run) || w.phase.tag !== "stopping") return;
    const { intent } = w.phase;
    if (intent === "remove") {
      workers.delete(w.spec.id);
      persistPids();
      notify({ ...snapshot(w), state: "stopped", pid: null, startedAt: null });
      return;
    }
    const signal = run.proc.signalCode;
    afterRun(w, intent, exitCode, signal == null ? null : String(signal), run.startedAt);
    persistPids();
  }

  function afterRun(
    w: Worker,
    reason: RestartReason,
    exitCode: number | null,
    signal: string | null,
    startedAt: number,
  ): void {
    const now = cfg.now();
    const policy = RESTART_POLICY[reason];
    if (now - startedAt >= cfg.backoffResetMs) w.failureStreak = 0;
    if (policy.failure) {
      w.failureStreak++;
      w.failureTimes = [...w.failureTimes.filter((t) => t >= now - cfg.unstableWindowMs), now];
    }
    const backoffMs =
      policy.backoff && w.failureStreak > 0
        ? Math.min(cfg.backoffBaseMs * 2 ** (w.failureStreak - 1), cfg.backoffMaxMs)
        : 0;
    w.restarts++;
    w.lastRestart = { reason, at: now, exitCode };
    try {
      appendRestart(opts.logDir, {
        at: now,
        id: w.spec.id,
        kind: w.spec.kind,
        reason,
        exitCode,
        signal,
        backoffMs,
        stderrTail: [...w.tail],
      });
    } catch (e) {
      pushTail(w, `[supervisor] restart log write failed: ${(e as Error).message}`);
    }
    if (backoffMs === 0) {
      start(w);
      return;
    }
    const timer = setTimeout(() => {
      if (workers.get(w.spec.id) === w && w.phase.tag === "backoff" && w.phase.timer === timer) start(w);
    }, backoffMs);
    setPhase(w, { tag: "backoff", timer, until: now + backoffMs });
  }

  function signalTerm(run: Run): void {
    if (run.killTimer) return;
    signalGroup(run.pid, "SIGTERM");
    run.killTimer = setTimeout(() => signalGroup(run.pid, "SIGKILL"), cfg.killGraceMs);
  }

  function stop(w: Worker, intent: StopIntent): void {
    const { phase } = w;
    switch (phase.tag) {
      case "pending":
        return;
      case "running":
        setPhase(w, { tag: "stopping", run: phase.run, intent });
        signalTerm(phase.run);
        return;
      case "stopping":
        // Removal wins over a pending restart; a re-add turns removal back into a restart.
        if (phase.intent !== intent && (intent === "remove" || phase.intent === "remove")) {
          setPhase(w, { tag: "stopping", run: phase.run, intent });
        }
        return;
      case "backoff":
        clearTimeout(phase.timer);
        if (intent === "remove") {
          workers.delete(w.spec.id);
          notify({ ...snapshot(w), state: "stopped" });
        } else {
          start(w);
        }
        return;
    }
  }

  function scheduleStallCheck(w: Worker, run: Run, delayMs: number): void {
    run.stallTimer = setTimeout(async () => {
      run.stallTimer = null;
      const stall = w.spec.stall;
      if (!isCurrent(w, run) || w.phase.tag !== "running") return;
      if (!stall) {
        if (!w.phase.confirmed) setPhase(w, { ...w.phase, confirmed: true });
        return;
      }
      const healthy = await checkHealthy(stall);
      if (!isCurrent(w, run) || w.phase.tag !== "running") return;
      if (!healthy) {
        pushTail(w, "[supervisor] stall check failed");
        stop(w, "stall");
        return;
      }
      if (!w.phase.confirmed) setPhase(w, { ...w.phase, confirmed: true });
      scheduleStallCheck(w, run, w.spec.stall?.intervalMs ?? 0);
    }, delayMs);
  }

  /** A check that hangs longer than one interval counts as unhealthy. */
  async function checkHealthy(stall: NonNullable<WorkerSpec["stall"]>): Promise<boolean> {
    let timer: Timer | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => stall.healthy()),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), stall.intervalMs);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function sameLaunch(a: WorkerSpec, b: WorkerSpec): boolean {
    const envKey = (s: WorkerSpec) => JSON.stringify(Object.entries(s.env ?? {}).sort(([x], [y]) => (x < y ? -1 : 1)));
    return (
      a.cmd.length === b.cmd.length &&
      a.cmd.every((c, i) => c === b.cmd[i]) &&
      (a.cwd ?? null) === (b.cwd ?? null) &&
      envKey(a) === envKey(b)
    );
  }

  function reconcile(specs: WorkerSpec[]): void {
    const next = new Map(specs.map((s) => [s.id, s]));
    for (const [id, w] of workers) {
      if (!next.has(id)) stop(w, "remove");
    }
    for (const spec of next.values()) {
      const w = workers.get(spec.id);
      if (!w) {
        const fresh: Worker = {
          spec,
          phase: { tag: "pending" },
          restarts: 0,
          failureStreak: 0,
          failureTimes: [],
          lastRestart: null,
          tail: [],
        };
        workers.set(spec.id, fresh);
        start(fresh);
        continue;
      }
      const changed = !sameLaunch(w.spec, spec);
      const hadStall = !!w.spec.stall;
      w.spec = spec;
      if (changed) {
        stop(w, "spec-changed");
      } else if (w.phase.tag === "stopping" && w.phase.intent === "remove") {
        stop(w, "manual");
      } else if (w.phase.tag === "running" && !hadStall && spec.stall && !w.phase.run.stallTimer) {
        const elapsed = cfg.now() - w.phase.run.startedAt;
        setPhase(w, { ...w.phase, confirmed: false });
        scheduleStallCheck(w, w.phase.run, Math.max(0, spec.stall.graceMs - elapsed));
      }
    }
  }

  return {
    ready,
    apply(specs) {
      if (closed) return;
      const ids = new Set<string>();
      for (const s of specs) {
        if (ids.has(s.id)) throw new Error(`duplicate worker id: ${s.id}`);
        ids.add(s.id);
      }
      desired = specs;
      if (isReady) reconcile(specs);
    },
    restart(id, reason = "manual") {
      if (closed) return;
      const w = workers.get(id);
      if (!w) throw new Error(`unknown worker: ${id}`);
      if (w.phase.tag === "stopping") return;
      stop(w, reason);
    },
    status() {
      return [...workers.values()].map(snapshot);
    },
    subscribe(listener): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async shutdown() {
      closed = true;
      await ready;
      for (const w of [...workers.values()]) stop(w, "remove");
      while (runEnded.size > 0) await Promise.all([...runEnded]);
      writePidFile(cfg.pidFile, []);
    },
  };
}
