import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSettings, type Camera, type CameraId, type Settings } from "../types.ts";
import { segmentPath } from "./layout.ts";

export async function tempSettings(): Promise<Settings> {
  return defaultSettings(await mkdtemp(join(tmpdir(), "cookienvr-rec-")));
}

export function camera(id: string, record: Partial<Camera["config"]["record"]> = {}, enabled = true): Camera {
  return {
    id: id as CameraId,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    config: {
      name: id,
      enabled,
      connection: { type: "tapo", host: "10.0.0.2", username: "u", password: "p" },
      record: { enabled: true, audio: true, direct: false, ...record },
    },
  };
}

/** Writes a segment file of `size` bytes whose mtime is `mtimeMs`. */
export async function writeSegment(settings: Settings, cameraId: string, startMs: number, size: number, mtimeMs: number) {
  const path = segmentPath(settings.storagePath, cameraId, startMs);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(size));
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}
