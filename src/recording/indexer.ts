import type { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SEGMENT_SECONDS, type CameraId, type Settings } from "../types.ts";
import { DAY_MS, dayKey, isDayKey, parseSegmentPath, type DayKey } from "./layout.ts";
import { allSegments, closeSegment, deleteSegment, insertSegmentIfMissing, updateOpenSize } from "./store.ts";
import { STALL_MS } from "./worker.ts";

/**
 * The newest file of a camera is still being written unless it has not changed
 * for longer than a full segment plus the stall window; past that, ffmpeg has
 * stopped (recording disabled, camera removed) and no newer file will close it.
 */
export const ABANDONED_MS = SEGMENT_SECONDS * 1000 + STALL_MS;

interface DiskSegment {
  cameraId: CameraId;
  path: string;
  startMs: number;
  mtimeMs: number;
  size: number;
}

export interface Indexer {
  /** Indexes today's and yesterday's (UTC) directories. */
  scanOnce(now: number): Promise<void>;
  /** Full startup reconciliation between disk and the segments table. */
  reconcile(now: number): Promise<void>;
  /** Runs `fn` while no scan or reconcile is in flight, so it cannot be undone by a scan that read the disk earlier. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function createIndexer(deps: { db: Database; settings: () => Settings }): Indexer {
  const { db } = deps;
  const root = () => resolve(deps.settings().storagePath);

  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  }

  async function scan(days: (cameraDays: DayKey[]) => DayKey[]): Promise<DiskSegment[]> {
    const found: DiskSegment[] = [];
    for (const cameraId of await listDir(root())) {
      const cameraPath = join(root(), cameraId);
      const present = (await listDir(cameraPath)).filter(isDayKey);
      for (const day of days(present)) {
        const dir = join(cameraPath, day);
        for (const name of await listDir(dir)) {
          const path = join(dir, name);
          const parsed = parseSegmentPath(path);
          if (!parsed) continue;
          const st = await stat(path).catch(() => null);
          if (!st?.isFile()) continue;
          found.push({ cameraId: parsed.cameraId, path, startMs: parsed.startMs, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
        }
      }
    }
    return found;
  }

  function apply(found: DiskSegment[], now: number) {
    const byCamera = Map.groupBy(found, (s) => s.cameraId);
    db.transaction(() => {
      for (const segments of byCamera.values()) {
        segments.sort((a, b) => a.startMs - b.startMs);
        segments.forEach((s, i) => {
          insertSegmentIfMissing(db, s.cameraId, s.path, s.startMs, s.size);
          const isNewest = i === segments.length - 1;
          if (!isNewest || now - s.mtimeMs > ABANDONED_MS) closeSegment(db, s.path, s.mtimeMs, s.size);
          else updateOpenSize(db, s.path, s.size);
        });
      }
    })();
  }

  return {
    exclusive,

    scanOnce: (now) =>
      exclusive(async () => {
        const wanted = new Set([dayKey(now - DAY_MS), dayKey(now)]);
        apply(await scan((present) => present.filter((d) => wanted.has(d))), now);
      }),

    reconcile: (now) =>
      exclusive(async () => {
        const found = await scan((present) => present);
        const onDisk = new Set(found.map((s) => s.path));
        const missing: number[] = [];
        for (const s of allSegments(db)) {
          if (onDisk.has(s.path)) continue;
          // Rows outside the current storagePath (it was changed) are checked individually.
          if (!(await stat(s.path).then((st) => st.isFile(), () => false))) missing.push(s.id);
        }
        db.transaction(() => missing.forEach((id) => deleteSegment(db, id)))();
        apply(found, now);
      }),
  };
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
