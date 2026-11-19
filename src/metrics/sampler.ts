import type { GpuDto, MetricsDto, MetricsPointDto, UsageDto } from "../api-types.ts";
import { attribute, byCategory, type UsageTarget, type WorkerUsage } from "./breakdown.ts";
import { createIntelProbe, type GpuReading, type ProbeOutcome, probeApple, probeNvidia } from "./gpu.ts";
import { type MetricsIo, systemIo } from "./io.ts";
import type { ProcSample } from "./parse.ts";
import { type CpuCounter, cpuPercent, detectSource, listProcSamples, type MemoryReading, readCpuCounter, readMemory, type ResourceSource } from "./system.ts";

export const METRICS_INTERVAL_MS = 5_000;
export const HISTORY_MS = 10 * 60_000;
/** The status page polls with watch=1; after this long without a poll the expensive reads stop. */
export const WATCH_TTL_MS = 20_000;

export interface MetricsOptions {
  /** running process trees to break usage down by (same list the memory monitor watches) */
  targets: () => UsageTarget[];
  selfPid?: number;
  /**
   * Extra lines under a GPU, e.g. object detection reporting "推論：每秒 12 張" for the device it runs
   * on. Called on every read; match on `gpu.vendor` and `gpu.id` (which carries the PCI address).
   */
  gpuExtras?: (gpu: Omit<GpuDto, "extras">) => GpuDto["extras"];
  io?: MetricsIo;
  intervalMs?: number;
  now?: () => number;
  onError?: (e: unknown) => void;
}

export interface MetricsDiagnostics {
  platform: string;
  source: ResourceSource | null;
  memoryDetail: string | null;
  latest: MetricsDto | null;
  workers: WorkerUsage[];
  probes: ProbeOutcome[];
  gpuDetails: { id: string; detail: string }[];
  /** wall time of a sampling pass: cheap (CPU + memory only) and full (plus processes and GPUs) */
  cost: { cheapMs: number | null; fullMs: number | null; samples: number };
  watched: boolean;
}

export interface Metrics {
  /** watch=true keeps the expensive reads on for WATCH_TTL_MS; the first watched call waits for them */
  read(opts: { watch: boolean }): Promise<MetricsDto>;
  sample(): Promise<void>;
  diagnostics(): Promise<MetricsDiagnostics>;
  start(): void;
  stop(): void;
}

const avg = (prev: number | null, v: number) => (prev === null ? v : prev * 0.8 + v * 0.2);

export function createMetrics(opts: MetricsOptions): Metrics {
  const io = opts.io ?? systemIo;
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? METRICS_INTERVAL_MS;
  const selfPid = opts.selfPid ?? process.pid;
  const intel = createIntelProbe();

  let source: ResourceSource | null = null;
  let sourcePromise: Promise<ResourceSource> | null = null;
  let lastCpu: CpuCounter | null = null;
  let cpuPct: number | null = null;
  let memory: MemoryReading | null = null;
  let lastProcs: { atMs: number; cpu: Map<number, number> } | null = null;
  let workers: WorkerUsage[] = [];
  let usage: UsageDto[] | null = null;
  let probes: ProbeOutcome[] = [];
  let gpus: GpuReading[] = [];
  let history: MetricsPointDto[] = [];
  let watchedUntil = 0;
  let detailedOnce = false;
  let cost = { cheapMs: null as number | null, fullMs: null as number | null, samples: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;

  const watched = () => now() < watchedUntil;
  const getSource = () => (sourcePromise ??= detectSource(io).then((s) => (source = s)));

  async function readGpus(): Promise<void> {
    const t = now();
    const results = await Promise.all([probeNvidia(io), intel.probe(io, t * 1e6), probeApple(io)]);
    probes = results;
    gpus = results.flatMap((r) => r.gpus);
  }

  async function readProcesses(src: ResourceSource): Promise<void> {
    const t = now();
    const procs: ProcSample[] = await listProcSamples(io, src.pageSize);
    const targets = opts.targets();
    const prev = lastProcs;
    lastProcs = { atMs: t, cpu: new Map(procs.map((p) => [p.pid, p.cpuSec])) };
    if (!prev) return;
    const b = attribute(procs, prev.cpu, (t - prev.atMs) / 1000, src.cpu.cores, targets, selfPid);
    workers = b.workers;
    usage = byCategory(b);
  }

  async function sampleOnce(full: boolean): Promise<void> {
    const started = performance.now();
    const src = await getSource();
    const t = now();
    const counter = await readCpuCounter(io, src, t);
    cpuPct = cpuPercent(lastCpu, counter, src.cpu.cores);
    lastCpu = counter;
    memory = await readMemory(io, src);
    if (full) {
      await Promise.all([readProcesses(src), readGpus()]);
      detailedOnce = true;
    } else {
      // stale per-process deltas would span the unwatched gap; start over when someone looks again
      lastProcs = null;
    }
    const mem = memory;
    history.push({
      at: t,
      cpuPct,
      memPct: mem && mem.totalBytes > 0 ? (mem.usedBytes / mem.totalBytes) * 100 : 0,
      gpus: full ? Object.fromEntries(gpus.map((g) => [g.id, g.utilPct])) : {},
    });
    const cutoff = t - HISTORY_MS;
    if (history[0] && history[0].at < cutoff) history = history.filter((p) => p.at >= cutoff);
    const ms = performance.now() - started;
    cost = { ...cost, samples: cost.samples + 1, [full ? "fullMs" : "cheapMs"]: avg(full ? cost.fullMs : cost.cheapMs, ms) };
  }

  /** One pass at a time; a full pass requested while a cheap one runs waits for it, then runs. */
  async function sample(full = watched()): Promise<void> {
    while (inflight) await inflight;
    inflight = sampleOnce(full).finally(() => (inflight = null));
    return inflight;
  }

  function dto(src: ResourceSource, detailed: boolean): MetricsDto {
    const mem = memory ?? { usedBytes: 0, totalBytes: src.memory.totalBytes };
    const list: GpuDto[] = gpus.map(({ detail: _detail, ...g }) => ({ ...g, extras: opts.gpuExtras?.(g) ?? [] }));
    const ours = usage?.reduce((a, u) => ({ cpu: a.cpu + u.cpuPct, mem: a.mem + u.memBytes }), { cpu: 0, mem: 0 });
    return {
      at: history.at(-1)?.at ?? now(),
      intervalMs,
      cpu: { pct: cpuPct, cores: src.cpu.cores, scope: src.cpu.scope },
      memory: { usedBytes: mem.usedBytes, totalBytes: mem.totalBytes, scope: src.memory.scope },
      gpus: list,
      gpuMissing: list.length ? null : probes.length === 0 ? null : probes.some((p) => p.state === "error") ? "unreadable" : "none",
      usage: detailed ? usage : null,
      other: detailed && ours && cpuPct !== null ? { cpuPct: Math.max(0, cpuPct - ours.cpu), memBytes: Math.max(0, mem.usedBytes - ours.mem) } : null,
      history,
    };
  }

  return {
    async read({ watch }) {
      if (watch) {
        const was = watched();
        watchedUntil = now() + WATCH_TTL_MS;
        if (!was && !detailedOnce) await sample();
        else if (!was) void sample().catch((e) => opts.onError?.(e));
      }
      const src = source ?? (await getSource());
      if (history.length === 0) await sample();
      return dto(src, watched());
    },
    sample: () => sample(),
    async diagnostics() {
      // a report should carry GPU and per-process numbers even if nobody had the status page open;
      // per-process CPU is a delta, so an unwatched sampler needs two passes a moment apart
      if (!watched() || !lastProcs) {
        await sample(true);
        await Bun.sleep(1_000);
        await sample(true);
      }
      const src = source ?? (await getSource());
      return {
        platform: `${io.platform} ${process.arch}`,
        source: src,
        memoryDetail: memory?.detail ?? null,
        latest: dto(src, true),
        workers,
        probes,
        gpuDetails: gpus.map((g) => ({ id: g.id, detail: g.detail })),
        cost,
        watched: watched(),
      };
    },
    start() {
      if (timer) return;
      void sample().catch((e) => opts.onError?.(e));
      timer = setInterval(() => void sample().catch((e) => opts.onError?.(e)), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
