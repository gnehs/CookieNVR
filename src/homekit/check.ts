/**
 * HKSV prerequisites, read from the restream's main stream: the video must be H.264 and keyframes
 * should come at most 4 s apart (each HKSV fragment starts on a keyframe and may not exceed the
 * hub's fragment length, normally 4 s).
 */

export interface StreamCheck {
  at: number;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  audioCodec: string | null;
  /** Median gap between keyframes; null when fewer than two keyframes arrived in the window. */
  keyframeIntervalSec: number | null;
}

export type Eligibility =
  | { ok: true; warning: "keyframe-interval" | null }
  | { ok: false; reason: "not-h264" | "no-video" };

export const MAX_KEYFRAME_INTERVAL_SEC = 4;
/** Long enough to see three keyframes from a camera with a 4 s interval. */
export const CHECK_WINDOW_SEC = 9;

export function eligibility(c: StreamCheck): Eligibility {
  if (!c.videoCodec) return { ok: false, reason: "no-video" };
  if (c.videoCodec !== "h264") return { ok: false, reason: "not-h264" };
  const slow = c.keyframeIntervalSec === null || c.keyframeIntervalSec > MAX_KEYFRAME_INTERVAL_SEC;
  return { ok: true, warning: slow ? "keyframe-interval" : null };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** `ffprobe -show_streams -show_packets -of json` output → summary. */
export function parseProbe(json: unknown, at: number): StreamCheck {
  const o = (json ?? {}) as { streams?: Record<string, unknown>[]; packets?: Record<string, unknown>[] };
  const streams = Array.isArray(o.streams) ? o.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const keyTimes = (Array.isArray(o.packets) ? o.packets : [])
    .filter((p) => video && p.stream_index === video.index && typeof p.flags === "string" && p.flags.includes("K"))
    .map((p) => Number(p.pts_time))
    .filter(Number.isFinite);
  const gaps = keyTimes.slice(1).map((t, i) => t - keyTimes[i]!).filter((g) => g > 0);
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  return {
    at,
    videoCodec: typeof video?.codec_name === "string" ? video.codec_name : null,
    width: num(video?.width),
    height: num(video?.height),
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : null,
    keyframeIntervalSec: gaps.length ? Math.round(median(gaps) * 100) / 100 : null,
  };
}

export function probeArgs(ffprobeBin: string, url: string): string[] {
  return [
    ffprobeBin,
    ...["-v", "error", "-rtsp_transport", "tcp", "-timeout", "10000000"],
    ...["-read_intervals", `%+${CHECK_WINDOW_SEC}`],
    ...["-show_entries", "stream=index,codec_type,codec_name,width,height:packet=stream_index,pts_time,flags"],
    ...["-of", "json", url],
  ];
}

export async function checkStream(ffprobeBin: string, url: string, now = Date.now): Promise<StreamCheck> {
  const proc = Bun.spawn(probeArgs(ffprobeBin, url), { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), (CHECK_WINDOW_SEC + 12) * 1000);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `ffprobe exited with ${code}`);
    return parseProbe(JSON.parse(out), now());
  } finally {
    clearTimeout(timer);
  }
}
