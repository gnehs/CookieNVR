import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { closeSegment, insertSegmentIfMissing } from "../recording/store.ts";
import type { CameraId } from "../types.ts";

/** A fragmented MP4 like the recorder writes: H.264 with a keyframe every second, plus AAC audio. */
export async function makeClip(path: string, seconds: number, opts: { audio?: boolean } = {}): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const audio = opts.audio ?? true;
  const proc = Bun.spawn(
    [
      "ffmpeg",
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25"],
      ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []),
      ...["-t", String(seconds), "-c:v", "libx264", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0", "-pix_fmt", "yuv420p"],
      ...(audio ? ["-c:a", "aac"] : ["-an"]),
      ...["-movflags", "frag_keyframe+empty_moov+default_base_moof", path],
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${err}`);
}

/** Registers `source` as a closed segment (or an open one when endMs is null) at the given start. */
export function addSegment(
  db: Database,
  cameraId: CameraId,
  source: string,
  path: string,
  startMs: number,
  endMs: number | null,
  size: number,
): void {
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(source, path);
  insertSegmentIfMissing(db, cameraId, path, startMs, size);
  if (endMs !== null) closeSegment(db, path, endMs, size);
}

export interface Probe {
  durationS: number;
  video: { codec: string; width: number } | null;
  audio: { codec: string } | null;
}

export async function probe(path: string): Promise<Probe> {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width", "-of", "json", path], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = JSON.parse(await new Response(proc.stdout).text()) as {
    format: { duration?: string };
    streams: { codec_type: string; codec_name: string; width?: number }[];
  };
  await proc.exited;
  const v = out.streams.find((s) => s.codec_type === "video");
  const a = out.streams.find((s) => s.codec_type === "audio");
  return {
    durationS: Number(out.format.duration ?? 0),
    video: v ? { codec: v.codec_name, width: v.width ?? 0 } : null,
    audio: a ? { codec: a.codec_name } : null,
  };
}
