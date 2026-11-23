import type { Database } from "bun:sqlite";
import type { EventBoxDto, EventDto, EventSourceKind } from "../api-types.ts";
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
  thumb_boxes: string | null;
}

function parseLabels(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isBox(v: unknown): v is EventBoxDto {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Partial<EventBoxDto>;
  return typeof b.label === "string" && isUnit(b.score) && Array.isArray(b.box) && b.box.length === 4 && b.box.every(isUnit);
}

/** 存的 JSON 壞掉或格式不對就當作沒有框 */
function parseBoxes(raw: string): EventBoxDto[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isBox).map((b) => ({ label: b.label, score: b.score, box: b.box })) : [];
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
  thumbBoxes: r.thumb_boxes === null ? null : parseBoxes(r.thumb_boxes),
});

const COLUMNS = "id, camera_id, source, start_ms, end_ms, score, labels, has_thumb, thumb_boxes";

/** 事件的 labels 含任一指定類別；null = 不篩選 */
const LABEL_MATCH = `(?L IS NULL OR EXISTS (SELECT 1 FROM json_each(labels) WHERE value IN (SELECT value FROM json_each(?L))))`;
const labelsParam = (labels: string[] | null) => (labels && labels.length ? JSON.stringify(labels) : null);

export interface EventQuery {
  cameraId: CameraId | null;
  labels: string[] | null;
  /** events overlapping [startMs, endMs); an event still in progress overlaps everything after its start */
  startMs: number;
  endMs: number;
  limit: number;
}

export function queryEvents(db: Database, q: EventQuery): EventDto[] {
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM events
       WHERE (?1 IS NULL OR camera_id = ?1) AND start_ms < ?2 AND (end_ms IS NULL OR end_ms > ?3) AND ${LABEL_MATCH.replaceAll("?L", "?5")}
       ORDER BY start_ms, id
       LIMIT ?4`,
    )
    .all(q.cameraId, q.endMs, q.startMs, q.limit, labelsParam(q.labels)) as EventRow[];
  return rows.map(toDto);
}

/** 開始時間早於 before 的事件，由新到舊（事件頁翻頁用） */
export function eventsBefore(db: Database, q: { cameraId: CameraId | null; labels: string[] | null; before: number; limit: number }): EventDto[] {
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM events WHERE (?1 IS NULL OR camera_id = ?1) AND start_ms < ?2 AND ${LABEL_MATCH.replaceAll("?L", "?4")} ORDER BY start_ms DESC, id DESC LIMIT ?3`,
    )
    .all(q.cameraId, q.before, q.limit, labelsParam(q.labels)) as EventRow[];
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

/** thumbBoxes 沒給就不動；給 null 代表縮圖換成了沒有框的快照 */
export function updateEvent(
  db: Database,
  id: number,
  patch: { source?: EventSourceKind; score?: number; labels?: string[]; hasThumb?: boolean; thumbBoxes?: EventBoxDto[] | null; endMs?: number },
): EventDto | null {
  const row = db
    .query(
      `UPDATE events SET source = COALESCE(?2, source), score = COALESCE(?3, score), labels = COALESCE(?4, labels),
         has_thumb = COALESCE(?5, has_thumb), end_ms = COALESCE(?6, end_ms), thumb_boxes = CASE WHEN ?7 THEN ?8 ELSE thumb_boxes END
       WHERE id = ?1 RETURNING ${COLUMNS}`,
    )
    .get(
      id,
      patch.source ?? null,
      patch.score ?? null,
      patch.labels ? JSON.stringify(patch.labels) : null,
      patch.hasThumb === undefined ? null : patch.hasThumb ? 1 : 0,
      patch.endMs ?? null,
      patch.thumbBoxes === undefined ? 0 : 1,
      patch.thumbBoxes ? JSON.stringify(patch.thumbBoxes) : null,
    ) as EventRow | null;
  return row ? toDto(row) : null;
}

/** 事件期間一張辨識結果的框 */
export function insertEventBoxes(db: Database, eventId: number, atMs: number, boxes: readonly EventBoxDto[]): void {
  db.query(`INSERT INTO event_boxes (event_id, at_ms, boxes) VALUES (?, ?, ?)`).run(eventId, atMs, JSON.stringify(boxes));
}

export interface BoxSample {
  atMs: number;
  boxes: EventBoxDto[];
}

export function eventBoxes(db: Database, eventId: number): BoxSample[] {
  const rows = db.query(`SELECT at_ms, boxes FROM event_boxes WHERE event_id = ? ORDER BY at_ms`).all(eventId) as { at_ms: number; boxes: string }[];
  return rows.map((r) => ({ atMs: r.at_ms, boxes: parseBoxes(r.boxes) }));
}

/** 上次主程序沒收尾的事件：結束時間取現在，但不超過這台的事件長度上限 */
export function closeDangling(db: Database, now: number, maxMsOf: (cameraId: CameraId) => number): number {
  const open = db.query(`SELECT id, camera_id, start_ms FROM events WHERE end_ms IS NULL`).all() as { id: number; camera_id: string; start_ms: number }[];
  const close = db.query(`UPDATE events SET end_ms = ?2 WHERE id = ?1`);
  for (const e of open) close.run(e.id, Math.max(e.start_ms, Math.min(now, e.start_ms + maxMsOf(e.camera_id as CameraId))));
  return open.length;
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
