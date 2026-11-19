import type { UsageCategory, UsageDto } from "../api-types.ts";
import type { CameraId, WorkerKind } from "../types.ts";
import type { ProcSample } from "./parse.ts";

/** A process tree the supervisor (or the export manager) owns. */
export interface UsageTarget {
  id: string;
  kind: WorkerKind;
  pid: number;
}

export const CATEGORY_OF: Record<WorkerKind, UsageCategory> = {
  record: "record",
  detect: "detect",
  detector: "detector",
  live: "live",
  restream: "restream",
  homekit: "homekit",
  "hksv-stream": "homekit",
  export: "export",
};

/** Kinds whose worker id is "<prefix>:<cameraId>[:…]" and so belong to one camera. */
const PER_CAMERA = new Set<WorkerKind>(["record", "detect", "live", "hksv-stream"]);

export interface WorkerUsage {
  id: string;
  kind: WorkerKind;
  cpuPct: number;
  memBytes: number;
  processes: number;
}

export interface Breakdown {
  workers: WorkerUsage[];
  /** the main process plus children no worker owns (ffprobe, ps …) */
  system: { cpuPct: number; memBytes: number };
}

/**
 * Splits CPU and memory of our process tree into workers. Each process is charged to the nearest
 * ancestor that is a worker root; whatever else descends from `selfPid` is "system". CPU is the delta
 * from `prev` over `dtSec`, in percent of `cores` (so it shares a base with the overall CPU number).
 * A process missing from `prev` started during the interval and is charged all its CPU time.
 */
export function attribute(
  procs: readonly ProcSample[],
  prev: ReadonlyMap<number, number>,
  dtSec: number,
  cores: number,
  targets: readonly UsageTarget[],
  selfPid: number,
): Breakdown {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rootOf = new Map<number, string>();
  for (const t of targets) rootOf.set(t.pid, t.id);
  const owner = new Map<number, string | null>();
  /** worker id, "system" for our own tree, or null for someone else's process */
  function ownerOf(pid: number): string | null {
    const seen: number[] = [];
    let cur: number | undefined = pid;
    let found: string | null = null;
    while (cur !== undefined && cur > 0) {
      if (owner.has(cur)) {
        found = owner.get(cur)!;
        break;
      }
      seen.push(cur);
      const root = rootOf.get(cur);
      if (root !== undefined) {
        found = root;
        break;
      }
      if (cur === selfPid) {
        found = "system";
        break;
      }
      const parent: number | undefined = byPid.get(cur)?.ppid;
      cur = parent === cur ? undefined : parent;
      if (seen.length > 4096) break;
    }
    for (const p of seen) owner.set(p, found);
    return found;
  }

  const acc = new Map<string, { cpuSec: number; mem: number; n: number }>();
  for (const p of procs) {
    const who = ownerOf(p.pid);
    if (who === null) continue;
    const was = prev.get(p.pid);
    const delta = was === undefined ? p.cpuSec : Math.max(0, p.cpuSec - was);
    const a = acc.get(who) ?? { cpuSec: 0, mem: 0, n: 0 };
    a.cpuSec += delta;
    a.mem += p.rssBytes;
    a.n++;
    acc.set(who, a);
  }
  const pct = (sec: number) => (dtSec > 0 ? Math.min(100, (sec / dtSec / cores) * 100) : 0);
  const workers = targets.map((t) => {
    const a = acc.get(t.id);
    return { id: t.id, kind: t.kind, cpuPct: pct(a?.cpuSec ?? 0), memBytes: a?.mem ?? 0, processes: a?.n ?? 0 };
  });
  const s = acc.get("system");
  return { workers, system: { cpuPct: pct(s?.cpuSec ?? 0), memBytes: s?.mem ?? 0 } };
}

const ORDER: UsageCategory[] = ["record", "detect", "detector", "live", "restream", "homekit", "export", "system"];

/** Workers grouped into the categories the status page shows, in a fixed order. */
export function byCategory(b: Breakdown): UsageDto[] {
  const out = new Map<UsageCategory, UsageDto>(ORDER.map((c) => [c, { category: c, cpuPct: 0, memBytes: 0, cameras: [] }]));
  for (const w of b.workers) {
    const u = out.get(CATEGORY_OF[w.kind])!;
    u.cpuPct += w.cpuPct;
    u.memBytes += w.memBytes;
    const cameraId = PER_CAMERA.has(w.kind) ? (w.id.split(":")[1] as CameraId | undefined) : undefined;
    if (!cameraId) continue;
    const cam = u.cameras.find((c) => c.cameraId === cameraId);
    if (cam) {
      cam.cpuPct += w.cpuPct;
      cam.memBytes += w.memBytes;
    } else u.cameras.push({ cameraId, cpuPct: w.cpuPct, memBytes: w.memBytes });
  }
  const sys = out.get("system")!;
  sys.cpuPct = b.system.cpuPct;
  sys.memBytes = b.system.memBytes;
  return [...out.values()];
}
