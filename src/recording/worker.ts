import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "../env.ts";
import { SEGMENT_SECONDS, type Camera, type Settings, type WorkerSpec } from "../types.ts";
import { DAY_MS, dayDir, dayKey, strftimePattern } from "./layout.ts";

/** The recording file must grow at least this often, or the worker counts as stalled. */
export const STALL_MS = 30_000;

export function isRecording(camera: Camera): boolean {
  return camera.config.enabled && camera.config.record.enabled;
}

export function recordWorkerSpec(
  camera: Camera,
  settings: Settings,
  inputUrl: string,
  env: Env,
  clock: () => number = Date.now,
): WorkerSpec {
  const { connection, record } = camera.config;
  const transport = record.direct && connection.type === "rtsp" ? connection.transport : "tcp";

  const cmd = [
    env.ffmpegBin,
    ...["-hide_banner", "-nostdin", "-loglevel", "warning"],
    ...["-rtsp_transport", transport],
    // RTSP demuxer timeout is in microseconds; without it a dead camera hangs ffmpeg forever.
    ...["-timeout", "10000000"],
    // Stream analysis reads 2-3 s of live packets before the first segment is opened and named; without
    // nobuffer those packets go into that file, so its media runs longer than the wall time its name implies.
    ...["-fflags", "nobuffer"],
    ...["-i", inputUrl],
    ...["-map", "0:v:0"],
    // The trailing "?" makes the audio map optional, so a stream without audio still records.
    ...(record.audio ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "64k"] : ["-an"]),
    ...["-c:v", "copy"],
    ...["-f", "segment"],
    ...["-segment_time", String(SEGMENT_SECONDS), "-segment_atclocktime", "1", "-reset_timestamps", "1"],
    ...["-strftime", "1"],
    ...["-segment_format", "mp4"],
    // flush_packets reaches the inner mp4 muxer; without it ffmpeg buffers ~256 KiB per write, which
    // delays live playback of the current segment, hides growth from the stall check and is lost on SIGKILL.
    ...["-segment_format_options", "movflags=frag_keyframe+empty_moov+default_base_moof:flush_packets=1"],
    strftimePattern(settings.storagePath, camera.id),
  ];

  return {
    id: `record:${camera.id}`,
    kind: "record",
    cmd,
    env: { TZ: "UTC" },
    stall: {
      intervalMs: 10_000,
      graceMs: STALL_MS,
      healthy: async () => {
        const now = clock();
        const mtime = await newestMtime(settings.storagePath, camera, now);
        return mtime !== null && now - mtime < STALL_MS;
      },
    },
  };
}

/** Mtime of the newest segment in the day directories the current file can live in. */
async function newestMtime(storagePath: string, camera: Camera, now: number): Promise<number | null> {
  let newest: number | null = null;
  for (const day of new Set([dayKey(now - STALL_MS), dayKey(now)])) {
    const dir = dayDir(storagePath, camera.id, day);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    // HHMMSS names sort chronologically, so only the last one can be the file being written.
    const latest = names.filter((n) => n.endsWith(".mp4")).sort().at(-1);
    if (latest === undefined) continue;
    try {
      const { mtimeMs } = await stat(join(dir, latest));
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch {}
  }
  return newest;
}

/**
 * ffmpeg does not create directories, so today's and tomorrow's must exist before it rolls over.
 * Returns the failures instead of rejecting: one camera's unwritable path must not hold back the others.
 */
export async function ensureDayDirs(cameras: Camera[], settings: Settings, now: number): Promise<unknown[]> {
  const days = [dayKey(now), dayKey(now + DAY_MS)];
  const results = await Promise.allSettled(
    cameras
      .filter(isRecording)
      .flatMap((c) => days.map((d) => mkdir(dayDir(settings.storagePath, c.id, d), { recursive: true }))),
  );
  return results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
}
