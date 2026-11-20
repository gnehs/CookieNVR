import type { ProbeResult, StreamInfo } from "../api-types.ts";
import type { Env } from "../env.ts";
import { msg, zh, type Msg } from "../messages/index.ts";
import type { CameraConnection } from "../types.ts";
import { probeOnvif, type OnvifProbeOptions } from "../ptz/probe.ts";
import { sourceUrls } from "../restream/source-urls.ts";

export interface ProbeOptions {
  /** 單一 ffprobe / ffmpeg 呼叫的時間上限 */
  timeoutMs?: number;
  onvif?: OnvifProbeOptions;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface RunResult {
  code: number | null;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
  missingBinary: boolean;
}

async function run(cmd: string[], timeoutMs: number): Promise<RunResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: null, stdout: new Uint8Array(), stderr: "", timedOut: false, missingBinary: true };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut, missingBinary: false };
}

function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]*@/g, "$1***@");
}

/** ffmpeg 原文的最後幾行（已遮住帳密），只給「複製錯誤內容」與診斷資訊用 */
function stderrTail(stderr: string): string | undefined {
  const tail = redact(stderr).trim().split("\n").slice(-6).join("\n");
  return tail || undefined;
}

export function explainFailure(stderr: string, timedOut: boolean, isTapo: boolean): Msg {
  const text = stderr;
  // ffmpeg 只在 warning 等級才會印出 "Operation timed out" 這類真正的原因
  if (/\b401\b|Unauthorized/i.test(text)) return msg(isTapo ? "probe.badCredentialsTapo" : "probe.badCredentials");
  if (/\b403\b|Forbidden/i.test(text)) return msg("probe.forbidden");
  if (/\b(400|404)\b|Not Found|Bad Request/i.test(text)) return msg("probe.notFound");
  if (/\b(453|503)\b|Not Enough Bandwidth|Service Unavailable/i.test(text)) return msg("probe.rejected");
  if (/Connection refused/i.test(text)) return msg("probe.refused");
  // 連上了 RTSP 埠但相機不回應或直接掛斷：最常見是其他軟體佔滿了相機的串流連線
  if (/Failed reading RTSP data|Connection reset by peer/i.test(text)) return msg("probe.noVideo");
  if (/No route to host|Network is unreachable|Host is down/i.test(text)) return msg("probe.unreachable");
  if (/Name or service not known|nodename nor servname|Failed to resolve|name resolution/i.test(text)) {
    return msg("probe.dnsFailed");
  }
  if (timedOut || /timed out/i.test(text)) return msg("probe.timeout");
  const last = text.trim().split("\n").at(-1);
  return last ? msg("probe.readFailed", { line: last }) : msg("probe.readFailedUnknown");
}

function parseRate(rate: unknown): number {
  if (typeof rate !== "string") return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return Math.round((num / den) * 100) / 100;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

function toStreamInfo(streams: FfprobeStream[]): StreamInfo | null {
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) return null;
  const audio = streams.find((s) => s.codec_type === "audio");
  return {
    videoCodec: video.codec_name ?? "unknown",
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseRate(video.r_frame_rate) || parseRate(video.avg_frame_rate),
    audioCodec: audio?.codec_name ?? null,
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Msg; detail?: string };

function failure(stream: "main" | "sub", m: Msg, detail?: string): ProbeResult {
  return { ok: false, error: `${stream === "main" ? "主碼流" : "子碼流"}：${zh(m)}`, errorMsg: m, stream, detail };
}

export async function probeCamera(
  conn: CameraConnection,
  env: Env,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = conn.type === "rtsp" ? conn.transport : "tcp";
  const isTapo = conn.type === "tapo";
  const urls = sourceUrls(conn);
  // ffmpeg 的 -timeout 單位是微秒，設成略短於整體上限，讓它自己報出較有意義的錯誤
  const ioTimeout = String(Math.max(1, timeoutMs - 2_000) * 1000);
  const input = (url: string) => ["-rtsp_transport", transport, "-timeout", ioTimeout, "-i", url];

  async function probeStream(url: string): Promise<Outcome<StreamInfo>> {
    const r = await run(
      [env.ffprobeBin, "-v", "warning", "-print_format", "json", "-show_streams", ...input(url)],
      timeoutMs,
    );
    if (r.missingBinary) return { ok: false, error: msg("probe.noFfprobe", { bin: env.ffprobeBin }) };
    const detail = stderrTail(r.stderr);
    if (r.code !== 0) return { ok: false, error: explainFailure(redact(r.stderr), r.timedOut, isTapo), detail };
    let streams: FfprobeStream[] = [];
    try {
      streams = (JSON.parse(new TextDecoder().decode(r.stdout)) as { streams?: FfprobeStream[] }).streams ?? [];
    } catch {
      // 落到下面的「沒有影像」
    }
    const info = toStreamInfo(streams);
    if (!info) return { ok: false, error: msg("probe.noVideoTrack"), detail };
    // 有 SDP 但沒收到任何畫面時 ffprobe 仍會成功結束，只是寬高是 0
    if (!info.width || !info.height) return { ok: false, error: msg("probe.noVideo"), detail };
    return { ok: true, value: info };
  }

  // ONVIF 與串流同時探測，連不上不影響串流測試的結果
  const onvif = probeOnvif(conn, opts.onvif);
  const main = await probeStream(urls.main);
  if (!main.ok) return failure("main", main.error, main.detail);

  let sub: StreamInfo | null = null;
  if (urls.sub !== null) {
    const r = await probeStream(urls.sub);
    if (r.ok) sub = r.value;
    // 部分 Tapo 機型沒有 stream2，視為沒有子碼流；通用 RTSP 是使用者明確填的，失敗就要告知
    else if (!isTapo) return failure("sub", r.error, r.detail);
  }

  return { ok: true, main: main.value, sub, snapshotJpegBase64: await snapshot(urls.main), onvif: await onvif };

  async function snapshot(url: string): Promise<string | null> {
    const r = await run(
      [env.ffmpegBin, "-v", "warning", ...input(url), "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1"],
      timeoutMs,
    );
    const isJpeg = r.stdout[0] === 0xff && r.stdout[1] === 0xd8;
    return r.code === 0 && isJpeg ? Buffer.from(r.stdout).toString("base64") : null;
  }
}
