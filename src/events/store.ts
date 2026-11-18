import type { Database } from "bun:sqlite";
import type { EventDto } from "../api-types.ts";
import type { CameraId } from "../types.ts";

interface EventRow {
  id: number;
  camera_id: string;
  source: "pixel" | "onvif";
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

export function getEvent(db: Database, id: number): EventDto | null {
  const row = db
    .query(`SELECT id, camera_id, source, start_ms, end_ms, score, labels, has_thumb FROM events WHERE id = ?`)
    .get(id) as EventRow | null;
  return row ? toDto(row) : null;
}
