import type { Database } from "bun:sqlite";
import { rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CameraId } from "../types.ts";
import { cameraDir, parseSegmentPath } from "./layout.ts";

export interface PurgeDeps {
  db: Database;
  storagePath: () => string;
  dataDir: string;
}

export interface PurgeResult {
  segments: number;
  events: number;
  bytes: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * A row's path is only trusted when it has the recording layout
 * `<root>/<cameraId>/<YYYYMMDD>/<HHMMSS>.mp4` for this very camera and is already normalized,
 * so a bad row can never point the deletion at anything else. Roots other than the current
 * storagePath are allowed because the setting may have changed since the file was written.
 */
function ownedSegmentPath(path: string, cameraId: string): boolean {
  return isAbsolute(path) && resolve(path) === path && parseSegmentPath(path)?.cameraId === cameraId;
}

/** Deletes everything the camera ever recorded. Safe to repeat; missing files are fine. */
export async function purgeCamera(deps: PurgeDeps, cameraId: CameraId): Promise<PurgeResult> {
  if (!SAFE_ID.test(cameraId)) throw new Error(`refusing to purge unsafe camera id: ${cameraId}`);
  const { db } = deps;

  const segments = db.query(`SELECT path, size FROM segments WHERE camera_id = ?`).all(cameraId) as {
    path: string;
    size: number;
  }[];
  let bytes = 0;
  for (const s of segments) {
    bytes += s.size;
    if (!ownedSegmentPath(s.path, cameraId)) continue;
    await rm(s.path, { force: true });
    // Best effort: leaves the directories alone unless they are now empty.
    const day = dirname(s.path);
    if (await rmdir(day).then(() => true, () => false)) await rmdir(dirname(day)).catch(() => {});
  }

  const dir = cameraDir(deps.storagePath(), cameraId);
  if (basename(dir) === cameraId) await rm(dir, { recursive: true, force: true });

  const events = db.query(`SELECT id FROM events WHERE camera_id = ?`).all(cameraId) as { id: number }[];
  for (const e of events) await rm(join(deps.dataDir, "thumbs", `${e.id}.jpg`), { force: true });

  db.transaction(() => {
    db.query(`DELETE FROM segments WHERE camera_id = ?`).run(cameraId);
    db.query(`DELETE FROM events WHERE camera_id = ?`).run(cameraId);
  })();
  return { segments: segments.length, events: events.length, bytes };
}

/** Camera ids that still own rows in the database but are not in `isLive`. */
export function orphanedCameraIds(db: Database, isLive: (id: CameraId) => boolean): CameraId[] {
  const rows = db
    .query(`SELECT camera_id FROM segments UNION SELECT camera_id FROM events`)
    .all() as { camera_id: string }[];
  return rows.map((r) => r.camera_id as CameraId).filter((id) => !isLive(id));
}

/** Purges every camera that `isLive` rejects. */
export async function purgeOrphans(deps: PurgeDeps, isLive: (id: CameraId) => boolean): Promise<PurgeResult> {
  const total: PurgeResult = { segments: 0, events: 0, bytes: 0 };
  for (const id of orphanedCameraIds(deps.db, isLive)) {
    if (!SAFE_ID.test(id)) continue;
    const r = await purgeCamera(deps, id);
    total.segments += r.segments;
    total.events += r.events;
    total.bytes += r.bytes;
  }
  return total;
}
