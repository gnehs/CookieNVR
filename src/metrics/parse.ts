/**
 * Pure parsers for the text the metrics module reads: cgroup v2 files, /proc, macOS `ps`, `vm_stat`
 * and `ioreg`, `nvidia-smi` CSV and DRM fdinfo. Each returns null (or skips a line) on input it does
 * not recognise instead of throwing, so one odd file never takes the sampler down.
 */

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
};

/** `cpu.max` is "$MAX $PERIOD"; "max" means no quota. Returns the quota in cores, or null for none. */
export function parseCpuMax(text: string): number | null {
  const [max, period] = text.trim().split(/\s+/);
  if (max === undefined || max === "max") return null;
  const quota = num(max);
  const p = num(period ?? "100000");
  return quota !== null && p !== null && p > 0 ? quota / p : null;
}

/** `cpu.stat`: the `usage_usec` line. */
export function parseCpuStatUsage(text: string): number | null {
  return num(/^usage_usec\s+(\d+)/m.exec(text)?.[1]);
}

/** A cpuset list such as "0-3,6,8-9" → number of CPUs. Empty means "inherit", returned as null. */
export function parseCpuList(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  let count = 0;
  for (const part of t.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    count += m[2] === undefined ? 1 : Number(m[2]) - Number(m[1]) + 1;
  }
  return count;
}

/** `memory.max`: bytes, or null for "max". */
export function parseMemoryMax(text: string): number | null {
  const t = text.trim();
  return t === "max" ? null : num(t);
}

/** `memory.stat` → key/value map (all values are bytes or counts). */
export function parseKeyValues(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+(\d+)$/.exec(line.trim());
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

/**
 * Memory a container is really using, the way `docker stats` reports it on cgroup v2:
 * `memory.current` minus `inactive_file` (page cache the kernel can drop at once).
 */
export function cgroupMemoryUsed(current: number, stat: Map<string, number>): number {
  return Math.max(0, current - (stat.get("inactive_file") ?? 0));
}

/** `/proc/meminfo` → { total, available } in bytes. */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const total = num(/^MemTotal:\s+(\d+)\s*kB/m.exec(text)?.[1]);
  const avail = num(/^MemAvailable:\s+(\d+)\s*kB/m.exec(text)?.[1]);
  if (total === null || avail === null) return null;
  return { totalBytes: total * 1024, availableBytes: avail * 1024 };
}

/** `/proc/self/cgroup`: the cgroup v2 path ("0::/docker/abc" → "/docker/abc"). */
export function parseSelfCgroup(text: string): string | null {
  return /^0::(\S*)$/m.exec(text)?.[1] ?? null;
}

/**
 * macOS `vm_stat`. "Used" follows Activity Monitor's Memory Used: app memory (anonymous pages that
 * are not purgeable) + wired + compressed. It is an approximation; Apple does not document the formula.
 */
export function parseVmStat(text: string): { usedBytes: number } | null {
  const pageSize = num(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (label: string) => num(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text)?.[1]);
  const anon = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable") ?? 0;
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor") ?? 0;
  if (pageSize === null || anon === null || wired === null) return null;
  return { usedBytes: (Math.max(0, anon - purgeable) + wired + compressed) * pageSize };
}

export interface ProcSample {
  pid: number;
  ppid: number;
  /** user + system CPU time so far */
  cpuSec: number;
  rssBytes: number;
}

/** Linux's USER_HZ, the unit of utime/stime in /proc/<pid>/stat; fixed at 100 in the kernel ABI. */
export const CLOCK_TICKS = 100;

/**
 * `/proc/<pid>/stat`. The command name (field 2) is in parentheses and may itself contain spaces or
 * ")", so fields are counted from the last ")".
 */
export function parsePidStat(text: string, pageSize: number): ProcSample | null {
  const close = text.lastIndexOf(")");
  const pid = num(text.slice(0, text.indexOf(" ")));
  if (close < 0 || pid === null) return null;
  // after ")": state(3) ppid(4) ... utime(14) stime(15) ... rss(24)
  const f = text.slice(close + 2).trim().split(/\s+/);
  const ppid = num(f[1]);
  const utime = num(f[11]);
  const stime = num(f[12]);
  const rss = num(f[21]);
  if (ppid === null || utime === null || stime === null || rss === null) return null;
  return { pid, ppid, cpuSec: (utime + stime) / CLOCK_TICKS, rssBytes: rss * pageSize };
}

/** `ps` cumulative CPU time: macOS prints "MMM:SS.ss", procps prints "[DD-]HH:MM:SS". */
export function parsePsTime(text: string): number | null {
  const m = /^(?:(\d+)-)?([\d:.]+)$/.exec(text.trim());
  if (!m) return null;
  const parts = m[2]!.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p)) || parts.length < 2 || parts.length > 3) return null;
  const [a, b, c] = parts as [number, number, number?];
  const sec = c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
  return Number(m[1] ?? 0) * 86400 + sec;
}

/** Output of `ps -A -o pid=,ppid=,rss=,time=` (rss in KB). */
export function parsePsCpu(text: string): ProcSample[] {
  const out: ProcSample[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    const cpu = m ? parsePsTime(m[4]!) : null;
    if (m && cpu !== null) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSec: cpu, rssBytes: Number(m[3]) * 1024 });
  }
  return out;
}

export interface NvidiaGpu {
  index: number;
  pciBusId: string;
  name: string;
  utilPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  temperatureC: number | null;
}

/** The fields, in order, passed to `nvidia-smi --query-gpu`; the parser depends on this order. */
export const NVIDIA_QUERY = "index,pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu";

/** nvidia-smi marks unavailable values "N/A", "[N/A]" or "[Not Supported]". */
const nvNum = (s: string | undefined) => (s === undefined || /N\/A|Not Supported|Unknown/i.test(s) ? null : num(s));
const MIB = 1024 * 1024;

/**
 * `nvidia-smi --query-gpu=<NVIDIA_QUERY> --format=csv,noheader,nounits`: one line per GPU. The name is
 * the only field that could contain a comma, so it is everything between the second and the last four.
 */
export function parseNvidiaSmi(text: string): NvidiaGpu[] {
  const out: NvidiaGpu[] = [];
  for (const line of text.split("\n")) {
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 7) continue;
    const index = num(f[0]);
    if (index === null) continue;
    const tail = f.slice(-4);
    const used = nvNum(tail[1]);
    const total = nvNum(tail[2]);
    out.push({
      index,
      pciBusId: normalizePciId(f[1]!),
      name: f.slice(2, -4).join(", "),
      utilPct: nvNum(tail[0]),
      memUsedBytes: used === null ? null : used * MIB,
      memTotalBytes: total === null ? null : total * MIB,
      temperatureC: nvNum(tail[3]),
    });
  }
  return out;
}

/** nvidia-smi prints "00000000:01:00.0" (8-digit domain); sysfs and fdinfo use "0000:01:00.0". */
export function normalizePciId(id: string): string {
  const m = /^([0-9a-f]+):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/i.exec(id.trim());
  if (!m) return id.trim().toLowerCase();
  return `${m[1]!.slice(-4).padStart(4, "0")}:${m[2]}:${m[3]}.${m[4]}`.toLowerCase();
}

/** One DRM client from `/proc/<pid>/fdinfo/<fd>` (kernel "DRM client usage stats"). */
export interface DrmClient {
  driver: string;
  pdev: string;
  clientId: string;
  /** i915 and others: busy time per engine in ns */
  engineNs: Map<string, number>;
  /** xe: busy and total GPU cycles per engine class */
  cycles: Map<string, number>;
  totalCycles: Map<string, number>;
  capacity: Map<string, number>;
}

export function parseDrmFdinfo(text: string): DrmClient | null {
  const driver = /^drm-driver:\s*(\S+)/m.exec(text)?.[1];
  const pdev = /^drm-pdev:\s*(\S+)/m.exec(text)?.[1];
  const clientId = /^drm-client-id:\s*(\d+)/m.exec(text)?.[1];
  if (!driver || !pdev || !clientId) return null;
  const c: DrmClient = { driver, pdev: pdev.toLowerCase(), clientId, engineNs: new Map(), cycles: new Map(), totalCycles: new Map(), capacity: new Map() };
  for (const line of text.split("\n")) {
    let m = /^drm-engine-capacity-(\S+):\s*(\d+)/.exec(line);
    if (m) {
      c.capacity.set(m[1]!, Number(m[2]));
      continue;
    }
    m = /^drm-engine-(\S+):\s*(\d+)\s*ns/.exec(line);
    if (m) {
      c.engineNs.set(m[1]!, Number(m[2]));
      continue;
    }
    m = /^drm-total-cycles-(\S+):\s*(\d+)/.exec(line);
    if (m) {
      c.totalCycles.set(m[1]!, Number(m[2]));
      continue;
    }
    m = /^drm-cycles-(\S+):\s*(\d+)/.exec(line);
    if (m) c.cycles.set(m[1]!, Number(m[2]));
  }
  return c;
}

/**
 * Busiest-engine utilisation of one GPU between two fdinfo readings, 0–100. Clients present in both
 * readings count; a client that appeared or went away in between has no baseline and is skipped.
 * - ns engines (i915): Δbusy / (Δwall × capacity)
 * - cycle engines (xe): Δcycles / Δtotal-cycles
 * Returns null when there is nothing to compare (first reading).
 */
export function drmUtilization(prev: readonly DrmClient[] | null, cur: readonly DrmClient[], wallNs: number): number | null {
  if (!prev || wallNs <= 0) return null;
  const before = new Map(prev.map((c) => [c.clientId, c]));
  const busy = new Map<string, number>();
  const add = (engine: string, v: number) => busy.set(engine, (busy.get(engine) ?? 0) + Math.max(0, v));
  for (const c of cur) {
    const p = before.get(c.clientId);
    if (!p) continue;
    for (const [engine, ns] of c.engineNs) {
      const was = p.engineNs.get(engine);
      if (was !== undefined) add(engine, (ns - was) / (wallNs * (c.capacity.get(engine) ?? 1)));
    }
    for (const [engine, cyc] of c.cycles) {
      const was = p.cycles.get(engine);
      const total = c.totalCycles.get(engine);
      const totalWas = p.totalCycles.get(engine);
      if (was === undefined || total === undefined || totalWas === undefined || total <= totalWas) continue;
      add(engine, (cyc - was) / ((total - totalWas) * (c.capacity.get(engine) ?? 1)));
    }
  }
  return Math.min(100, Math.max(0, ...busy.values()) * 100);
}

/** macOS `ioreg -r -d 1 -w 0 -c IOAccelerator`: the GPU model and its "Device Utilization %". */
export function parseIoregAccelerator(text: string): { model: string | null; utilPct: number | null }[] {
  const out: { model: string | null; utilPct: number | null }[] = [];
  // each accelerator is a "+-o" block; without the marker treat the whole text as one
  const blocks = text.includes("+-o") ? text.split(/^\+-o /m).slice(1) : [text];
  for (const b of blocks) {
    const util = num(/"Device Utilization %"\s*=\s*(\d+)/.exec(b)?.[1]);
    const model = /"model"\s*=\s*"([^"]*)"/.exec(b)?.[1] ?? null;
    if (util !== null || model !== null) out.push({ model, utilPct: util });
  }
  return out;
}
