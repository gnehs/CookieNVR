// detect worker：`bun src/detect/worker.ts <ffmpeg> <rtsp 網址> <控制檔> [JPEG 每秒張數]`
// 一個 ffmpeg 解碼一次，輸出兩路：每秒 5 張 320×180 灰階 raw（stdout）給差分，每秒 1 張（開物件辨識時依辨識頻率，最多 5 張）640 寬 JPEG（fd 3）給快照與辨識。
// 結果與 JPEG 以 protocol.ts 的格式寫到自己的 stdout，由主程序讀取。
import { readFileSync } from "node:fs";
import { FRAME_BYTES, FRAME_H, FRAME_W, MotionDetector } from "./motion.ts";
import { chunksOf, encodeMsg, IDLE_CONTROL, JpegSplitter, MsgKind, parseControl, type DetectControl, type FrameResult } from "./protocol.ts";

const [ffmpegBin, url, controlPath, fpsArg] = process.argv.slice(2);
// 解碼本身是每秒 5 張，JPEG 最多也是 5 張
const jpegFps = Math.min(5, Math.max(1, Math.round(Number(fpsArg ?? 1)) || 1));
if (!ffmpegBin || !url || !controlPath) {
  console.error("usage: worker.ts <ffmpeg> <rtsp-url> <control-file>");
  process.exit(2);
}

function detectCommand(ffmpeg: string, input: string, jpegFps: number): string[] {
  return [
    ffmpeg,
    ...["-hide_banner", "-nostdin", "-loglevel", "warning"],
    ...["-fflags", "nobuffer", "-probesize", "500000", "-analyzeduration", "500000"],
    ...["-rtsp_transport", "tcp", "-timeout", "10000000", "-i", input],
    "-filter_complex",
    `[0:v:0]fps=5,scale=640:-2,split=2[a][b];[a]scale=${FRAME_W}:${FRAME_H},format=gray[g];[b]fps=${jpegFps}[j]`,
    ...["-map", "[g]", "-f", "rawvideo", "pipe:1"],
    ...["-map", "[j]", "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "pipe:3"],
  ];
}

const out = Bun.stdout.writer();
let alive = true;
function send(kind: MsgKind, payload: Uint8Array): void {
  if (!alive) return;
  try {
    out.write(encodeMsg(kind, payload));
    void Promise.resolve(out.flush()).catch(() => process.exit(1));
  } catch {
    // 主程序不在了
    process.exit(1);
  }
}

const enc = new TextEncoder();
let controlText = "";
let control: DetectControl = IDLE_CONTROL;
const detector = new MotionDetector();
let wasPaused = false;

function refreshControl(): void {
  let text: string;
  try {
    text = readFileSync(controlPath!, "utf8");
  } catch {
    return;
  }
  if (text === controlText) return;
  const next = parseControl(text);
  if (!next) return;
  controlText = text;
  if (JSON.stringify(next.masks) !== JSON.stringify(control.masks)) detector.setMasks(next.masks);
  // 開始差分、或改了遮罩與門檻：舊的背景不能直接沿用
  if (next.diff && (!control.diff || next.threshold !== control.threshold || JSON.stringify(next.masks) !== JSON.stringify(control.masks))) detector.reset();
  control = next;
}

function judge(gray: Uint8Array): FrameResult {
  refreshControl();
  const at = Date.now();
  if (!control.diff) return { at, state: "off", score: null, motion: false };
  if (control.paused) {
    wasPaused = true;
    return { at, state: "paused", score: null, motion: false };
  }
  if (wasPaused) {
    wasPaused = false;
    detector.reset();
  }
  return { at, ...detector.process(gray, control) };
}

const proc = Bun.spawn(detectCommand(ffmpegBin, url, jpegFps), { stdio: ["ignore", "pipe", "inherit", "pipe"] });
const shutdown = () => {
  alive = false;
  proc.kill("SIGTERM");
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function readFrames(): Promise<void> {
  const frame = new Uint8Array(FRAME_BYTES);
  let filled = 0;
  for await (const chunk of chunksOf(proc.stdout)) {
    let p = 0;
    while (p < chunk.length) {
      const n = Math.min(FRAME_BYTES - filled, chunk.length - p);
      frame.set(chunk.subarray(p, p + n), filled);
      filled += n;
      p += n;
      if (filled === FRAME_BYTES) {
        filled = 0;
        send(MsgKind.frame, enc.encode(JSON.stringify(judge(frame))));
      }
    }
  }
}

async function readJpegs(): Promise<void> {
  const fd = (proc.stdio as unknown as (number | undefined)[])[3];
  if (typeof fd !== "number") return;
  const splitter = new JpegSplitter();
  for await (const chunk of chunksOf(Bun.file(fd).stream())) {
    for (const jpeg of splitter.push(chunk)) send(MsgKind.jpeg, jpeg);
  }
}

await Promise.all([readFrames(), readJpegs()]).catch((e) => console.error(`[detect] ${(e as Error).message}`));
const code = await proc.exited;
process.exit(code === 0 ? 1 : code);
