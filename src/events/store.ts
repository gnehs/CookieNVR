import type { Database } from "bun:sqlite";
import type { EventDto, EventSourceKind } from "../api-types.ts";
import type { CameraId } from "../types.ts";

interface EventRow {
  id: number;
  camera_id: string;
  source: EventSourceKind;
  start_ms: number;
  end_ms: number | null;
  score: number;
  labels: string;
  has_thumb: number;
}

function parseLabels(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const toDto = (r: EventRow): EventDto => ({
  id: r.id,
  cameraId: r.camera_id as CameraId,
  source: r.source,
  startMs: r.start_ms,
  endMs: r.end_ms,
  score: r.score,
  labels: parseLabels(r.labels),
  hasThumb: r.has_thumb === 1,
});

export interface EventQuery {
  cameraId: CameraId | null;
  /** events overlapping [startMs, endMs); an event still in progress overlaps everything after its start */
  startMs: number;
  endMs: number;
  limit: number;
}

export function queryEvents(db: Database, q: EventQuery): EventDto[] {
  const rows = db
    .query(
      `SELECT id, camera_id, source, start_ms, end_ms, score, labels, has_thumb FROM events
       WHERE (?1 IS NULL OR camera_id = ?1) AND start_ms < ?2 AND (end_ms IS NULL OR end_ms > ?3)
       ORDER BY start_ms, id
       LIMIT ?4`,
    )
    .all(q.cameraId, q.endMs, q.startMs, q.limit) as EventRow[];
  return rows.map(toDto);
}

const COLUMNS = "id, camera_id, source, start_ms, end_ms, score, labels, has_thumb";

/** 開始時間早於 before 的事件，由新到舊（事件頁翻頁用） */
export function eventsBefore(db: Database, q: { cameraId: CameraId | null; before: number; limit: number }): EventDto[] {
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM events WHERE (?1 IS NULL OR camera_id = ?1) AND start_ms < ?2 ORDER BY start_ms DESC, id DESC LIMIT ?3`,
    )
    .all(q.cameraId, q.before, q.limit) as EventRow[];
  return rows.map(toDto);
}

export function activeEvents(db: Database): EventDto[] {
  return (db.query(`SELECT ${COLUMNS} FROM events WHERE end_ms IS NULL ORDER BY start_ms, id`).all() as EventRow[]).map(toDto);
}

export function insertEvent(db: Database, e: { cameraId: CameraId; source: EventSourceKind; startMs: number; score: number; labels: string[] }): EventDto {
  const row = db
    .query(`INSERT INTO events (camera_id, source, start_ms, score, labels) VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`)
    .get(e.cameraId, e.source, e.startMs, e.score, JSON.stringify(e.labels)) as EventRow;
  return toDto(row);
}

export function updateEvent(db: Database, id: number, patch: { source?: EventSourceKind; score?: number; labels?: string[]; hasThumb?: boolean; endMs?: number }): EventDto | null {
  const row = db
    .query(
      `UPDATE events SET source = COALESCE(?2, source), score = COALESCE(?3, score), labels = COALESCE(?4, labels),
         has_thumb = COALESCE(?5, has_thumb), end_ms = COALESCE(?6, end_ms) WHERE id = ?1 RETURNING ${COLUMNS}`,
    )
    .get(id, patch.source ?? null, patch.score ?? null, patch.labels ? JSON.stringify(patch.labels) : null, patch.hasThumb === undefined ? null : patch.hasThumb ? 1 : 0, patch.endMs ?? null) as EventRow | null;
  return row ? toDto(row) : null;
}

/** 上次主程序沒收尾的事件：結束時間取現在，但不超過事件長度上限 */
export function closeDangling(db: Database, now: number, maxMs: number): number {
  return db.query(`UPDATE events SET end_ms = MAX(start_ms, MIN(?1, start_ms + ?2)) WHERE end_ms IS NULL`).run(now, maxMs).changes;
}

export function deleteEventRow(db: Database, id: number): void {
  db.query(`DELETE FROM events WHERE id = ?`).run(id);
}

/** 保留期限過了的事件 id（已結束且結束時間早於 cutoff） */
export function expiredEventIds(db: Database, cutoff: number): number[] {
  return (db.query(`SELECT id FROM events WHERE end_ms IS NOT NULL AND end_ms < ?`).all(cutoff) as { id: number }[]).map((r) => r.id);
}

export function countEventsSince(db: Database, cameraId: CameraId, since: number): number {
  return (db.query(`SELECT COUNT(*) AS n FROM events WHERE camera_id = ? AND start_ms >= ?`).get(cameraId, since) as { n: number }).n;
}

export function getEvent(db: Database, id: number): EventDto | null {
  const row = db
    .query(`SELECT ${COLUMNS} FROM events WHERE id = ?`)
    .get(id) as EventRow | null;
  return row ? toDto(row) : null;
}
