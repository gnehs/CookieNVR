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

/** Closed segments only, oldest first; recording segments are never candidates. */
export function retentionCandidates(db: Database, now: number, bufferMs: number): RetentionCandidate[] {
  const rows = db
    .query(
      `SELECT s.id, s.path, s.end_ms, s.size,
         EXISTS (
           SELECT 1 FROM events e
           WHERE e.camera_id = s.camera_id
             AND e.start_ms - ?2 < s.end_ms
             AND COALESCE(e.end_ms, ?1) + ?2 > s.start_ms
         ) AS near_event
       FROM segments s
       WHERE s.end_ms IS NOT NULL
       ORDER BY s.start_ms, s.id`,
    )
    .all(now, bufferMs) as { id: number; path: string; end_ms: number; size: number; near_event: number }[];
  return rows.map((r) => ({ id: r.id, path: r.path, endMs: r.end_ms, size: r.size, nearEvent: r.near_event === 1 }));
}

/** Total recorded bytes per camera, for the status page. */
export function usageByCamera(db: Database): { cameraId: CameraId; bytes: number }[] {
  const rows = db
    .query(`SELECT camera_id, SUM(size) AS bytes FROM segments GROUP BY camera_id ORDER BY camera_id`)
    .all() as { camera_id: string; bytes: number }[];
  return rows.map((r) => ({ cameraId: r.camera_id as CameraId, bytes: r.bytes }));
}
