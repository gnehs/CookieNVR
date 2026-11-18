import type { ProbeResult, StreamInfo } from "../api-types.ts";
import type { Env } from "../env.ts";
import type { CameraConnection } from "../types.ts";
import { sourceUrls } from "../restream/source-urls.ts";

export interface ProbeOptions {
  /** 單一 ffprobe / ffmpeg 呼叫的時間上限 */
  timeoutMs?: number;
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

export function explainFailure(stderr: string, timedOut: boolean, isTapo: boolean): string {
  const text = stderr;
  // ffmpeg 只在 warning 等級才會印出 "Operation timed out" 這類真正的原因
  if (/\b401\b|Unauthorized/i.test(text)) {
    return isTapo
      ? "帳號或密碼錯誤。請使用 Tapo App「進階設定 → 相機帳戶」建立的帳密，不是 TP-Link 雲端帳號"
      : "帳號或密碼錯誤";
  }
  if (/\b403\b|Forbidden/i.test(text)) return "攝影機拒絕存取（403），請確認帳號權限";
  if (/\b(400|404)\b|Not Found|Bad Request/i.test(text)) return "找不到這個串流，請檢查網址路徑是否正確";
  if (/\b(453|503)\b|Not Enough Bandwidth|Service Unavailable/i.test(text)) {
    return "攝影機拒絕了連線，可能是同時連線數已達上限，請稍後再試或關閉其他正在讀取的裝置";
  }
  if (/Connection refused/i.test(text)) {
    return "連線被拒絕，請確認 IP 位址與連接埠，以及攝影機的 RTSP 功能已開啟";
  }
  if (/No route to host|Network is unreachable|Host is down/i.test(text)) {
    return "無法連到這個位址，請確認攝影機已開機，且與本機在同一個網路";
  }
  if (/Name or service not known|nodename nor servname|Failed to resolve|name resolution/i.test(text)) {
    return "無法解析主機名稱，請檢查網址";
  }
  if (timedOut || /timed out/i.test(text)) {
    return "連線逾時，請確認 IP 位址正確、攝影機已開機且網路可連通";
  }
  const last = text.trim().split("\n").at(-1);
  return last ? `無法讀取串流：${last}` : "無法讀取串流";
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

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

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
    if (r.missingBinary) return { ok: false, error: `找不到 ffprobe（${env.ffprobeBin}），請確認已安裝` };
    if (r.code !== 0) return { ok: false, error: explainFailure(redact(r.stderr), r.timedOut, isTapo) };
    let streams: FfprobeStream[] = [];
    try {
      streams = (JSON.parse(new TextDecoder().decode(r.stdout)) as { streams?: FfprobeStream[] }).streams ?? [];
    } catch {
      // 落到下面的「沒有影像」
    }
    const info = toStreamInfo(streams);
    return info ? { ok: true, value: info } : { ok: false, error: "串流中沒有影像軌" };
  }

  const main = await probeStream(urls.main);
  if (!main.ok) return { ok: false, error: `主碼流：${main.error}` };

  let sub: StreamInfo | null = null;
  if (urls.sub !== null) {
    const r = await probeStream(urls.sub);
    if (r.ok) sub = r.value;
    // 部分 Tapo 機型沒有 stream2，視為沒有子碼流；通用 RTSP 是使用者明確填的，失敗就要告知
    else if (!isTapo) return { ok: false, error: `子碼流：${r.error}` };
  }

  return { ok: true, main: main.value, sub, snapshotJpegBase64: await snapshot(urls.main) };

  async function snapshot(url: string): Promise<string | null> {
    const r = await run(
      [env.ffmpegBin, "-v", "warning", ...input(url), "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1"],
      timeoutMs,
    );
    const isJpeg = r.stdout[0] === 0xff && r.stdout[1] === 0xd8;
    return r.code === 0 && isJpeg ? Buffer.from(r.stdout).toString("base64") : null;
  }
}
