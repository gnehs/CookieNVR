import type { Database } from "bun:sqlite";
import type { CameraId, Segment } from "../types.ts";

interface SegmentRow {
  id: number;
  camera_id: string;
  path: string;
  start_ms: number;
  end_ms: number | null;
  size: number;
}

const toSegment = (r: SegmentRow): Segment => ({
  id: r.id,
  cameraId: r.camera_id as CameraId,
  path: r.path,
  startMs: r.start_ms,
  endMs: r.end_ms,
  size: r.size,
});

const COLUMNS = "id, camera_id, path, start_ms, end_ms, size";

export function getSegment(db: Database, id: number): Segment | null {
  const row = db.query(`SELECT ${COLUMNS} FROM segments WHERE id = ?`).get(id) as SegmentRow | null;
  return row ? toSegment(row) : null;
}

export function allSegments(db: Database): Segment[] {
  return (db.query(`SELECT ${COLUMNS} FROM segments`).all() as SegmentRow[]).map(toSegment);
}

/** Segments overlapping [startMs, endMs), recording ones included. */
export function segmentsInRange(db: Database, cameraId: CameraId, startMs: number, endMs: number): Segment[] {
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM segments
       WHERE camera_id = ? AND start_ms < ? AND (end_ms IS NULL OR end_ms > ?)
       ORDER BY start_ms`,
    )
    .all(cameraId, endMs, startMs) as SegmentRow[];
  return rows.map(toSegment);
}

/** Distinct 15-minute UTC buckets touched by the camera's segments, as bucket start ms. */
export function quarterHourBuckets(db: Database, cameraId: CameraId): number[] {
  const rows = db
    .query(
      `SELECT start_ms / 900000 AS b FROM segments WHERE camera_id = ?1
       UNION
       SELECT end_ms / 900000 FROM segments WHERE camera_id = ?1 AND end_ms IS NOT NULL`,
    )
    .all(cameraId) as { b: number }[];
  return rows.map((r) => r.b * 900_000);
}

export function insertSegmentIfMissing(db: Database, cameraId: CameraId, path: string, startMs: number, size: number) {
  db.query(`INSERT OR IGNORE INTO segments (camera_id, path, start_ms, size) VALUES (?, ?, ?, ?)`).run(
    cameraId,
    path,
    startMs,
    size,
  );
}

/** Closes a recording segment; a segment already closed keeps its end and size. */
export function closeSegment(db: Database, path: string, endMs: number, size: number) {
  db.query(`UPDATE segments SET end_ms = ?, size = ? WHERE path = ? AND end_ms IS NULL`).run(endMs, size, path);
}

export function updateOpenSize(db: Database, path: string, size: number) {
  db.query(`UPDATE segments SET size = ? WHERE path = ? AND end_ms IS NULL`).run(size, path);
}

export function deleteSegment(db: Database, id: number) {
  db.query(`DELETE FROM segments WHERE id = ?`).run(id);
}

export interface RetentionCandidate {
  id: number;
  path: string;
  endMs: number;
  size: number;
  /** overlaps an event widened by bufferMs on each side */
  nearEvent: boolean;
}

/**
 * Closed segments only, oldest first; recording segments are never candidates.
 *
 * The overlap is computed here, not with a per-segment subquery: the (camera_id, start_ms) index bounds
 * only one side of the overlap, so SQLite walked every earlier event of the camera for every segment
 * (8 cameras with a week of segments and a month of events took 29 s, on the main thread).
 */
export function retentionCandidates(db: Database, now: number, bufferMs: number): RetentionCandidate[] {
  const segments = db
    .query(
      `SELECT id, camera_id, path, start_ms, end_ms, size FROM segments
       WHERE end_ms IS NOT NULL
       ORDER BY start_ms, id`,
    )
    .all() as (SegmentRow & { end_ms: number })[];
  const events = db
    .query(`SELECT camera_id, start_ms, COALESCE(end_ms, ?) AS end_ms FROM events ORDER BY start_ms`)
    .all(now) as { camera_id: string; start_ms: number; end_ms: number }[];

  // Per camera: event starts in order, and the latest end among the events up to each one.
  const byCamera = new Map<string, { starts: number[]; latestEnd: number[] }>();
  for (const e of events) {
    let c = byCamera.get(e.camera_id);
    if (!c) byCamera.set(e.camera_id, (c = { starts: [], latestEnd: [] }));
    c.starts.push(e.start_ms);
    c.latestEnd.push(Math.max(e.end_ms, c.latestEnd.at(-1) ?? -Infinity));
  }

  return segments.map((s) => {
    const c = byCamera.get(s.camera_id);
    let nearEvent = false;
    if (c) {
      // Events starting before the segment's end (widened); one of them overlaps if the latest end reaches the start.
      let lo = 0;
      let hi = c.starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (c.starts[mid]! - bufferMs < s.end_ms) lo = mid + 1;
        else hi = mid;
      }
      nearEvent = lo > 0 && c.latestEnd[lo - 1]! + bufferMs > s.start_ms;
    }
    return { id: s.id, path: s.path, endMs: s.end_ms, size: s.size, nearEvent };
  });
}

export interface RootUsage {
  /** The storagePath the segments were written under: everything before `/<cameraId>/` in the path. */
  root: string;
  cameraId: CameraId;
  bytes: number;
  oldestMs: number;
}

/** Recorded bytes per camera and per recording location, so a changed storagePath doesn't mix two disks. */
export function usageByRoot(db: Database): RootUsage[] {
  const rows = db
    .query(
      `SELECT substr(path, 1, instr(path, '/' || camera_id || '/') - 1) AS root, camera_id, SUM(size) AS bytes, MIN(start_ms) AS oldest
       FROM segments GROUP BY root, camera_id ORDER BY root, camera_id`,
    )
    .all() as { root: string; camera_id: string; bytes: number; oldest: number }[];
  return rows.map((r) => ({ root: r.root, cameraId: r.camera_id as CameraId, bytes: r.bytes, oldestMs: r.oldest }));
}
