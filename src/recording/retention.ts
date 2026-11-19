import type { Database } from "bun:sqlite";
import { readdir, rm, rmdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EVENT_BUFFER_MS, type Settings } from "../types.ts";
import { thumbPath } from "../events/paths.ts";
import { deleteEventRow, expiredEventIds } from "../events/store.ts";
import { DAY_MS, dayKey, isDayKey } from "./layout.ts";
import { deleteSegment, retentionCandidates } from "./store.ts";

export type FreeBytes = (path: string) => Promise<number>;

export const statfsFreeBytes: FreeBytes = async (path) => {
  const s = await statfs(path);
  return s.bavail * s.bsize;
};

export interface RetentionResult {
  deleted: number;
  freedBytes: number;
  /** 超過事件保留天數而刪除的事件（含縮圖） */
  events: number;
}

export interface Retention {
  runOnce(now: number): Promise<RetentionResult>;
}

export function createRetention(deps: {
  db: Database;
  settings: () => Settings;
  /** 縮圖在 <dataDir>/thumbs */
  dataDir: string;
  freeBytes?: FreeBytes;
}): Retention {
  const { db } = deps;
  const freeBytes = deps.freeBytes ?? statfsFreeBytes;

  return {
    async runOnce(now) {
      const { storagePath, retention } = deps.settings();
      const candidates = retentionCandidates(db, now, EVENT_BUFFER_MS);
      const doomed = new Set(
        candidates.filter((c) => {
          const days = c.nearEvent ? retention.eventDays : retention.continuousDays;
          return c.endMs < now - days * DAY_MS;
        }),
      );

      // Deleting the age-expired segments frees space too, so count it before evicting by age order.
      let deficit = retention.minFreeBytes - (await freeBytes(resolve(storagePath)));
      for (const c of doomed) deficit -= c.size;
      for (const c of candidates) {
        if (deficit <= 0) break;
        if (doomed.has(c)) continue;
        doomed.add(c);
        deficit -= c.size;
      }

      let freedBytes = 0;
      for (const c of doomed) {
        await rm(c.path, { force: true });
        deleteSegment(db, c.id);
        freedBytes += c.size;
      }
      await removeEmptyPastDayDirs(storagePath, now);

      // 事件本身與縮圖照事件保留天數；縮圖先刪，中斷時留下的是沒有縮圖的事件而不是孤兒檔
      const expired = expiredEventIds(db, now - retention.eventDays * DAY_MS);
      for (const id of expired) {
        await rm(thumbPath(deps.dataDir, id), { force: true });
        deleteEventRow(db, id);
      }
      return { deleted: doomed.size, freedBytes, events: expired.length };
    },
  };
}

/** Today's and tomorrow's directories are pre-created for ffmpeg and must survive while empty. */
async function removeEmptyPastDayDirs(storagePath: string, now: number) {
  const root = resolve(storagePath);
  const today = dayKey(now);
  for (const camera of await readdir(root).catch(() => [] as string[])) {
    for (const day of await readdir(join(root, camera)).catch(() => [] as string[])) {
      if (!isDayKey(day) || day >= today) continue;
      // rmdir refuses non-empty directories, which is exactly the check we want.
      await rmdir(join(root, camera, day)).catch(() => {});
    }
  }
}
