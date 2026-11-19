// detect worker：`bun src/detect/worker.ts <ffmpeg> <rtsp 網址> <控制檔> [JPEG 每秒張數]`，硬體解碼的設定在環境變數 DETECT_HW_DECODE。
// 一個 ffmpeg 解碼一次，輸出兩路：每秒 5 張 320×180 灰階 raw（stdout）給差分，每秒 1 張（開物件辨識時依辨識頻率，最多 5 張）640 寬 JPEG（fd 3）給快照與辨識。
// 結果與 JPEG 以 protocol.ts 的格式寫到自己的 stdout，由主程序讀取。
// 硬體解碼在第一張畫面之前就失敗（裝置、驅動、格式不支援、逾時）時，同一次執行內改用 CPU 重開 ffmpeg，偵測不中斷。
// 輸入端打不開（轉發層還沒有這條 path、相機連不上）時顯示卡還沒試到，直接結束，supervisor 重啟後照樣先試硬體。
import { readFileSync } from "node:fs";
import { CODEC_LABEL, explainHwFailure, inputFailed, type HwFailure } from "../hwcodec/commands.ts";
import type { HwDecode } from "../hwcodec/plan.ts";
import { detectCommand, HW_DECODE_ENV, parseHwDecode } from "./command.ts";
import { PREVIEW_THRESHOLDS } from "./config.ts";
import { FRAME_BYTES, MotionDetector } from "./motion.ts";
import { chunksOf, encodeMsg, IDLE_CONTROL, JpegSplitter, MsgKind, parseControl, type DecodeReport, type DetectControl, type FrameResult } from "./protocol.ts";

const [ffmpegBin, url, controlPath, fpsArg] = process.argv.slice(2);
// 解碼本身是每秒 5 張，JPEG 最多也是 5 張
const jpegFps = Math.min(5, Math.max(1, Math.round(Number(fpsArg ?? 1)) || 1));
if (!ffmpegBin || !url || !controlPath) {
  console.error("usage: worker.ts <ffmpeg> <rtsp-url> <control-file>");
  process.exit(2);
}
/** 硬體解碼這麼久還沒有第一張畫面，當作顯示卡卡住；加上 CPU 重開的時間仍要在 supervisor 的 20 秒寬限內 */
const HW_FIRST_FRAME_MS = 10_000;

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
  return { at, ...detector.process(gray, control, control.preview ? PREVIEW_THRESHOLDS : undefined) };
}

let proc: ReturnType<typeof spawnFfmpeg> | null = null;
const shutdown = () => {
  alive = false;
  proc?.kill("SIGTERM");
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function spawnFfmpeg(hw: HwDecode | null) {
  const { cmd, env } = detectCommand(ffmpegBin!, url!, jpegFps, hw);
  return Bun.spawn(cmd, { stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
}

async function readFrames(p: NonNullable<typeof proc>, onFrame: () => void): Promise<void> {
  const frame = new Uint8Array(FRAME_BYTES);
  let filled = 0;
  for await (const chunk of chunksOf(p.stdout)) {
    let i = 0;
    while (i < chunk.length) {
      const n = Math.min(FRAME_BYTES - filled, chunk.length - i);
      frame.set(chunk.subarray(i, i + n), filled);
      filled += n;
      i += n;
      if (filled === FRAME_BYTES) {
        filled = 0;
        onFrame();
        send(MsgKind.frame, enc.encode(JSON.stringify(judge(frame))));
      }
    }
  }
}

async function readJpegs(p: NonNullable<typeof proc>): Promise<void> {
  const fd = (p.stdio as unknown as (number | undefined)[])[3];
  if (typeof fd !== "number") return;
  const splitter = new JpegSplitter();
  for await (const chunk of chunksOf(Bun.file(fd).stream())) {
    for (const jpeg of splitter.push(chunk)) send(MsgKind.jpeg, jpeg);
  }
}

/** ffmpeg 的 stderr 照樣轉給 supervisor 收尾端，同時留最後一段判斷硬體解碼失敗的原因 */
async function forwardStderr(p: NonNullable<typeof proc>, keep: { text: string }): Promise<void> {
  const dec = new TextDecoder();
  for await (const chunk of chunksOf(p.stderr)) {
    process.stderr.write(chunk);
    keep.text = (keep.text + dec.decode(chunk, { stream: true })).slice(-4096);
  }
}

/** 跑一次 ffmpeg 到結束；回傳這次送出了幾張畫面 */
async function runOnce(hw: HwDecode | null, onFirstFrame: () => void) {
  const p = spawnFfmpeg(hw);
  proc = p;
  const stderr = { text: "" };
  let frames = 0;
  let timedOut = false;
  const timer = hw
    ? setTimeout(() => {
        if (frames > 0) return;
        timedOut = true;
        p.kill("SIGKILL");
      }, HW_FIRST_FRAME_MS)
    : null;
  const onFrame = () => {
    if (frames++ === 0) onFirstFrame();
  };
  await Promise.all([readFrames(p, onFrame), readJpegs(p), forwardStderr(p, stderr)]).catch((e) => console.error(`[detect] ${(e as Error).message}`));
  const code = await p.exited;
  if (timer) clearTimeout(timer);
  return { frames, code, stderr: stderr.text, timedOut };
}

const report = (r: DecodeReport) => send(MsgKind.decode, enc.encode(JSON.stringify(r)));
let hw = parseHwDecode(process.env[HW_DECODE_ENV]);
/** 硬體解碼失敗的原因；等 CPU 真的解出畫面才回報，相機連不上時不冤枉顯示卡 */
let failure: HwFailure | null = null;
let code = 1;
for (;;) {
  const current = hw;
  const r = await runOnce(current, () => {
    if (current) report({ mode: "hw", deviceId: current.deviceId });
    else if (failure) report({ mode: "cpu", ...failure });
  });
  code = r.code;
  if (!alive || !current || r.frames > 0 || inputFailed(r.stderr)) break;
  failure = explainHwFailure(current.api, `${CODEC_LABEL[current.codec]} 硬體解碼`, r.stderr, { timedOut: r.timedOut, exitCode: r.code });
  console.error(`[detect] ${current.deviceId} 硬體解碼沒有成功，改用 CPU：${failure.reason}`);
  hw = null;
}
process.exit(code === 0 ? 1 : code);
