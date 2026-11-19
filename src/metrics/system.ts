import { cpus, totalmem } from "node:os";
import type { ResourceScope } from "../api-types.ts";
import type { MetricsIo } from "./io.ts";
import {
  cgroupMemoryUsed,
  parseCpuList,
  parseCpuMax,
  parseCpuStatUsage,
  parseKeyValues,
  parseMeminfo,
  parseMemoryMax,
  parsePidStat,
  parsePsCpu,
  parseSelfCgroup,
  parseVmStat,
  type ProcSample,
} from "./parse.ts";

/** Where CPU and memory numbers come from, decided once at start (limits do not change while running). */
export interface ResourceSource {
  cgroup: { version: 2; dir: string } | { version: 1 } | null;
  hostCores: number;
  hostMemBytes: number;
  cpu: { scope: ResourceScope; cores: number; quotaCores: number | null; cpusetCores: number | null };
  memory: { scope: ResourceScope; totalBytes: number; limitBytes: number | null };
  pageSize: number;
}

/**
 * The container counts as its own scope only when it is actually limited: a quota or cpuset smaller
 * than the host, or a memory.max below host RAM. Without a limit the container can use the whole
 * machine, so the host numbers are what tell whether the hardware keeps up.
 */
export function decideScope(input: {
  hostCores: number;
  hostMemBytes: number;
  quotaCores: number | null;
  cpusetCores: number | null;
  memLimitBytes: number | null;
}): Pick<ResourceSource, "cpu" | "memory"> {
  const cores = Math.min(input.hostCores, input.quotaCores ?? Infinity, input.cpusetCores ?? Infinity);
  const memLimited = input.memLimitBytes !== null && input.memLimitBytes < input.hostMemBytes;
  return {
    cpu: { scope: cores < input.hostCores ? "container" : "host", cores, quotaCores: input.quotaCores, cpusetCores: input.cpusetCores },
    memory: { scope: memLimited ? "container" : "host", totalBytes: memLimited ? input.memLimitBytes! : input.hostMemBytes, limitBytes: input.memLimitBytes },
  };
}

async function cgroupDir(io: MetricsIo): Promise<ResourceSource["cgroup"]> {
  if (io.platform !== "linux") return null;
  if (!(await io.exists("/sys/fs/cgroup/cgroup.controllers"))) return (await io.exists("/sys/fs/cgroup/cpu")) ? { version: 1 } : null;
  // with a private cgroup namespace (Docker's default on v2) this is "/" and the mount is our own cgroup
  const path = parseSelfCgroup((await io.readText("/proc/self/cgroup")) ?? "") ?? "/";
  const nested = `/sys/fs/cgroup${path === "/" ? "" : path}`;
  return { version: 2, dir: (await io.exists(`${nested}/cpu.stat`)) ? nested : "/sys/fs/cgroup" };
}

async function linuxPageSize(io: MetricsIo): Promise<number> {
  const r = await io.run(["getconf", "PAGESIZE"], 2_000);
  const n = r.missing ? NaN : Number(r.stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : 4096;
}

export async function detectSource(io: MetricsIo): Promise<ResourceSource> {
  const hostCores = cpus().length || 1;
  let hostMemBytes = totalmem();
  if (io.platform === "linux") hostMemBytes = parseMeminfo((await io.readText("/proc/meminfo")) ?? "")?.totalBytes ?? hostMemBytes;
  const cgroup = await cgroupDir(io);
  let quotaCores: number | null = null;
  let cpusetCores: number | null = null;
  let memLimitBytes: number | null = null;
  if (cgroup?.version === 2) {
    quotaCores = parseCpuMax((await io.readText(`${cgroup.dir}/cpu.max`)) ?? "max");
    cpusetCores = parseCpuList((await io.readText(`${cgroup.dir}/cpuset.cpus.effective`)) ?? "");
    memLimitBytes = parseMemoryMax((await io.readText(`${cgroup.dir}/memory.max`)) ?? "max");
  }
  return {
    cgroup,
    hostCores,
    hostMemBytes,
    ...decideScope({ hostCores, hostMemBytes, quotaCores, cpusetCores, memLimitBytes }),
    pageSize: io.platform === "linux" ? await linuxPageSize(io) : 4096,
  };
}

/** A cumulative CPU counter; utilisation is the delta between two of these. */
export interface CpuCounter {
  atMs: number;
  /** CPU seconds used by the scope so far */
  busySec: number;
}

/** Host CPU from the kernel's per-CPU times (os.cpus reads /proc/stat on Linux, host_processor_info on macOS). */
function hostCpuCounter(atMs: number): CpuCounter {
  let busy = 0;
  for (const c of cpus()) busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
  return { atMs, busySec: busy / 1000 };
}

export async function readCpuCounter(io: MetricsIo, src: ResourceSource, atMs: number): Promise<CpuCounter | null> {
  if (src.cpu.scope === "container" && src.cgroup?.version === 2) {
    const usec = parseCpuStatUsage((await io.readText(`${src.cgroup.dir}/cpu.stat`)) ?? "");
    return usec === null ? null : { atMs, busySec: usec / 1e6 };
  }
  return hostCpuCounter(atMs);
}

/** Percent of the scope's cores, 0–100. */
export function cpuPercent(prev: CpuCounter | null, cur: CpuCounter | null, cores: number): number | null {
  if (!prev || !cur || cur.atMs <= prev.atMs) return null;
  const pct = ((cur.busySec - prev.busySec) / ((cur.atMs - prev.atMs) / 1000) / cores) * 100;
  return Math.min(100, Math.max(0, pct));
}

export interface MemoryReading {
  usedBytes: number;
  totalBytes: number;
  /** what the number is made of, for diagnostics */
  detail: string;
}

export async function readMemory(io: MetricsIo, src: ResourceSource): Promise<MemoryReading | null> {
  if (src.memory.scope === "container" && src.cgroup?.version === 2) {
    const current = Number((await io.readText(`${src.cgroup.dir}/memory.current`))?.trim());
    if (!Number.isFinite(current)) return null;
    const stat = parseKeyValues((await io.readText(`${src.cgroup.dir}/memory.stat`)) ?? "");
    const used = cgroupMemoryUsed(current, stat);
    return { usedBytes: used, totalBytes: src.memory.totalBytes, detail: `memory.current ${current} − inactive_file ${stat.get("inactive_file") ?? 0}` };
  }
  if (io.platform === "linux") {
    const m = parseMeminfo((await io.readText("/proc/meminfo")) ?? "");
    return m && { usedBytes: m.totalBytes - m.availableBytes, totalBytes: m.totalBytes, detail: "/proc/meminfo MemTotal − MemAvailable" };
  }
  if (io.platform === "darwin") {
    const r = await io.run(["vm_stat"], 2_000);
    const v = r.missing ? null : parseVmStat(r.stdout);
    return v && { usedBytes: v.usedBytes, totalBytes: src.hostMemBytes, detail: "vm_stat：App 記憶體 + 系統固定 + 壓縮（近似「活動監視器」）" };
  }
  return null;
}

/** All processes with CPU time and resident memory. Linux reads /proc (no fork); macOS forks `ps`. */
export async function listProcSamples(io: MetricsIo, pageSize: number): Promise<ProcSample[]> {
  if (io.platform === "linux") {
    const pids = ((await io.readDir("/proc")) ?? []).filter((n) => /^\d+$/.test(n));
    const out: ProcSample[] = [];
    for (const pid of pids) {
      const text = await io.readText(`/proc/${pid}/stat`);
      const p = text ? parsePidStat(text, pageSize) : null;
      if (p) out.push(p);
    }
    return out;
  }
  const r = await io.run(["ps", "-A", "-o", "pid=,ppid=,rss=,time="], 3_000);
  return r.missing || r.code !== 0 ? [] : parsePsCpu(r.stdout);
}
