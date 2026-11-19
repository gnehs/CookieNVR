import type { Database } from "bun:sqlite";
import type { StateChangeDto, StateImageSource, StateSensorConfig } from "../api-types.ts";
import type { CameraId } from "../types.ts";
import { storedConfig } from "./config.ts";

export type SensorId = string & { readonly __brand: "SensorId" };

export interface SensorRow {
  id: SensorId;
  cameraId: CameraId;
  config: StateSensorConfig;
  createdAt: number;
}

export interface ImageRow {
  id: string;
  sensorId: SensorId;
  file: string;
  label: string | null;
  source: StateImageSource;
  createdAt: number;
  guess: { label: string; score: number } | null;
}

export type ChangeRow = Omit<StateChangeDto, "thumbUrl"> & { hasThumb: boolean };

export const newSensorId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12) as SensorId;

export function listSensors(db: Database): SensorRow[] {
  const rows = db.query("SELECT id, camera_id, config, created_at FROM state_sensors ORDER BY created_at, id").all() as {
    id: string;
    camera_id: string;
    config: string;
    created_at: number;
  }[];
  return rows.map((r) => ({ id: r.id as SensorId, cameraId: r.camera_id as CameraId, config: storedConfig(r.config), createdAt: r.created_at }));
}

export function insertSensor(db: Database, s: SensorRow): void {
  db.query("INSERT INTO state_sensors (id, camera_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(s.id, s.cameraId, JSON.stringify(s.config), s.createdAt, s.createdAt);
}

export function updateSensorConfig(db: Database, id: SensorId, config: StateSensorConfig, now: number): void {
  db.query("UPDATE state_sensors SET config = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(config), now, id);
}

/** 感應器、它的圖片（cascade）與切換紀錄 */
export function deleteSensor(db: Database, id: SensorId): void {
  db.transaction(() => {
    db.query("DELETE FROM state_sensors WHERE id = ?").run(id);
    db.query("DELETE FROM state_changes WHERE sensor_id = ?").run(id);
  })();
}

interface ImageDbRow {
  id: string;
  sensor_id: string;
  file: string;
  label: string | null;
  source: StateImageSource;
  created_at: number;
  guess_label: string | null;
  guess_score: number | null;
}

const toImage = (r: ImageDbRow): ImageRow => ({
  id: r.id,
  sensorId: r.sensor_id as SensorId,
  file: r.file,
  label: r.label,
  source: r.source,
  createdAt: r.created_at,
  guess: r.guess_label !== null && r.guess_score !== null ? { label: r.guess_label, score: r.guess_score } : null,
});

export function listImages(db: Database, sensorId: SensorId): ImageRow[] {
  return (db.query("SELECT * FROM state_images WHERE sensor_id = ? ORDER BY created_at DESC, id").all(sensorId) as ImageDbRow[]).map(toImage);
}

export function getImage(db: Database, sensorId: SensorId, id: string): ImageRow | null {
  const r = db.query("SELECT * FROM state_images WHERE sensor_id = ? AND id = ?").get(sensorId, id) as ImageDbRow | null;
  return r ? toImage(r) : null;
}

export function insertImages(db: Database, rows: ImageRow[]): void {
  const q = db.query("INSERT INTO state_images (id, sensor_id, file, label, source, created_at, guess_label, guess_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const r of rows) q.run(r.id, r.sensorId, r.file, r.label, r.source, r.createdAt, r.guess?.label ?? null, r.guess?.score ?? null);
  })();
}

/** 回傳實際改到的張數 */
export function setImageLabels(db: Database, sensorId: SensorId, ids: string[], label: string | null): number {
  const q = db.query("UPDATE state_images SET label = ? WHERE sensor_id = ? AND id = ?");
  let n = 0;
  db.transaction(() => {
    for (const id of ids) n += q.run(label, sensorId, id).changes;
  })();
  return n;
}

export function relabel(db: Database, sensorId: SensorId, from: string, to: string | null): void {
  db.query("UPDATE state_images SET label = ? WHERE sensor_id = ? AND label = ?").run(to, sensorId, from);
}

/** 刪掉資料列，回傳被刪掉的檔名（由呼叫端刪檔） */
export function deleteImages(db: Database, sensorId: SensorId, ids: string[]): string[] {
  const files: string[] = [];
  db.transaction(() => {
    for (const id of ids) {
      const r = db.query("DELETE FROM state_images WHERE sensor_id = ? AND id = ? RETURNING file").get(sensorId, id) as { file: string } | null;
      if (r) files.push(r.file);
    }
  })();
  return files;
}

/** 辨識時自動存下的待標記圖片超過上限時，最舊的那些 */
export function overflowLiveImages(db: Database, sensorId: SensorId, keep: number): string[] {
  const rows = db
    .query("SELECT id FROM state_images WHERE sensor_id = ? AND label IS NULL AND source = 'live' ORDER BY created_at DESC, id LIMIT -1 OFFSET ?")
    .all(sensorId, keep) as { id: string }[];
  return rows.map((r) => r.id);
}

export function imageCounts(db: Database, sensorId: SensorId): Map<string | null, number> {
  const rows = db.query("SELECT label, COUNT(*) AS n FROM state_images WHERE sensor_id = ? GROUP BY label").all(sensorId) as { label: string | null; n: number }[];
  return new Map(rows.map((r) => [r.label, r.n]));
}

interface ChangeDbRow {
  id: number;
  sensor_id: string;
  camera_id: string;
  at: number;
  from_state: string | null;
  to_state: string;
  score: number;
  has_thumb: number;
}

const toChange = (r: ChangeDbRow): ChangeRow => ({
  id: r.id,
  sensorId: r.sensor_id,
  cameraId: r.camera_id as CameraId,
  at: r.at,
  from: r.from_state,
  to: r.to_state,
  score: r.score,
  hasThumb: r.has_thumb === 1,
});

export function insertChange(db: Database, c: Omit<ChangeRow, "id">): ChangeRow {
  const r = db
    .query("INSERT INTO state_changes (sensor_id, camera_id, at, from_state, to_state, score, has_thumb) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .get(c.sensorId, c.cameraId, c.at, c.from, c.to, c.score, c.hasThumb ? 1 : 0) as ChangeDbRow;
  return toChange(r);
}

export function setChangeThumb(db: Database, id: number): void {
  db.query("UPDATE state_changes SET has_thumb = 1 WHERE id = ?").run(id);
}

export function lastChange(db: Database, sensorId: SensorId): ChangeRow | null {
  const r = db.query("SELECT * FROM state_changes WHERE sensor_id = ? ORDER BY at DESC, id DESC LIMIT 1").get(sensorId) as ChangeDbRow | null;
  return r ? toChange(r) : null;
}

export function getChange(db: Database, id: number): ChangeRow | null {
  const r = db.query("SELECT * FROM state_changes WHERE id = ?").get(id) as ChangeDbRow | null;
  return r ? toChange(r) : null;
}

export function queryChanges(db: Database, q: { sensorId: string | null; cameraId: string | null; before: number | null; limit: number }): ChangeRow[] {
  const rows = db
    .query(
      `SELECT * FROM state_changes
       WHERE (?1 IS NULL OR sensor_id = ?1) AND (?2 IS NULL OR camera_id = ?2) AND (?3 IS NULL OR at < ?3)
       ORDER BY at DESC, id DESC LIMIT ?4`,
    )
    .all(q.sensorId, q.cameraId, q.before, q.limit) as ChangeDbRow[];
  return rows.map(toChange);
}

export function renameInChanges(db: Database, sensorId: SensorId, from: string, to: string): void {
  db.query("UPDATE state_changes SET from_state = ? WHERE sensor_id = ? AND from_state = ?").run(to, sensorId, from);
  db.query("UPDATE state_changes SET to_state = ? WHERE sensor_id = ? AND to_state = ?").run(to, sensorId, from);
}

/** 保留期限：和事件一樣。回傳被刪掉且有縮圖的紀錄（由呼叫端刪檔） */
export function deleteChangesBefore(db: Database, cutoff: number): { id: number; sensorId: SensorId }[] {
  const rows = db.query("DELETE FROM state_changes WHERE at < ? RETURNING id, sensor_id, has_thumb").all(cutoff) as { id: number; sensor_id: string; has_thumb: number }[];
  return rows.filter((r) => r.has_thumb === 1).map((r) => ({ id: r.id, sensorId: r.sensor_id as SensorId }));
}
