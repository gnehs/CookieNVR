import { basename, dirname, join, resolve } from "node:path";
import type { CameraId } from "../types.ts";

/**
 * On-disk layout of recordings, the single place that converts between
 * segment paths and UTC times:
 *   <storagePath>/<cameraId>/<YYYYMMDD>/<HHMMSS>.mp4
 */

export const DAY_MS = 86_400_000;

/** UTC day key, "YYYYMMDD". */
export type DayKey = string & { readonly __brand: "DayKey" };

const DAY_RE = /^(\d{4})(\d{2})(\d{2})$/;
const FILE_RE = /^(\d{2})(\d{2})(\d{2})\.mp4$/;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function dayKey(ms: number): DayKey {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` as DayKey;
}

export function isDayKey(name: string): name is DayKey {
  return DAY_RE.test(name);
}

export function cameraDir(storagePath: string, cameraId: CameraId | string): string {
  return join(resolve(storagePath), cameraId);
}

export function dayDir(storagePath: string, cameraId: CameraId | string, day: DayKey): string {
  return join(cameraDir(storagePath, cameraId), day);
}

export function segmentPath(storagePath: string, cameraId: CameraId | string, startMs: number): string {
  const d = new Date(startMs);
  const file = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.mp4`;
  return join(dayDir(storagePath, cameraId, dayKey(startMs)), file);
}

/**
 * ffmpeg `-strftime 1` output pattern producing exactly what segmentPath produces,
 * provided ffmpeg runs with TZ=UTC.
 */
export function strftimePattern(storagePath: string, cameraId: CameraId): string {
  const escaped = cameraDir(storagePath, cameraId).replaceAll("%", "%%");
  return join(escaped, "%Y%m%d", "%H%M%S.mp4");
}

/** Parses the last three path components, so segments under an old storagePath still parse. */
export function parseSegmentPath(path: string): { cameraId: CameraId; startMs: number } | null {
  const file = FILE_RE.exec(basename(path));
  const day = DAY_RE.exec(basename(dirname(path)));
  const cameraId = basename(dirname(dirname(path)));
  if (!file || !day || cameraId === "") return null;
  const [, y, mo, d] = day.map(Number) as [number, number, number, number];
  const [, h, mi, s] = file.map(Number) as [number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const startMs = Date.UTC(y, mo - 1, d, h, mi, s);
  if (dayKey(startMs) !== basename(dirname(path))) return null;
  return { cameraId: cameraId as CameraId, startMs };
}
