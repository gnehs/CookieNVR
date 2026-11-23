import type { EventBoxDto } from "../api-types.ts";

/** 框線粗細（像素）；縮圖約 640 寬、加框影片最高 720，這個粗細兩邊都看得清楚 */
const THICKNESS = 3;
/** 映像裡的 ffmpeg 沒有字型（沒有 drawtext），類別只能靠顏色分 */
const LABEL_COLORS: Record<string, string> = {
  person: "0xFF3B30",
  car: "0x0A84FF",
  truck: "0x0A84FF",
  bus: "0x0A84FF",
  motorcycle: "0x5AC8FA",
  bicycle: "0x5AC8FA",
  dog: "0x34C759",
  cat: "0x34C759",
  bird: "0x34C759",
};
const OTHER_COLORS = ["0xFF9F0A", "0xFFD60A", "0xBF5AF2", "0xFF375F", "0x64D2FF", "0x30D158"];

export function boxColor(label: string): string {
  const known = LABEL_COLORS[label];
  if (known) return known;
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OTHER_COLORS[h % OTHER_COLORS.length]!;
}

const unit = (v: number) => Math.min(1, Math.max(0, v)).toFixed(4);

/** 一個 drawbox 濾鏡；座標乘上畫面大小，所以放在縮放之後也對。enable 是輸出時間（秒），沒給就一直畫 */
export function drawbox(b: EventBoxDto, enable?: { fromS: number; toS: number }): string {
  const [x1, y1, x2, y2] = b.box;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const parts = [`x=iw*${unit(x)}`, `y=ih*${unit(y)}`, `w=iw*${unit(Math.abs(x2 - x1))}`, `h=ih*${unit(Math.abs(y2 - y1))}`, `color=${boxColor(b.label)}`, `t=${THICKNESS}`];
  if (enable) parts.push(`enable='between(t,${enable.fromS.toFixed(3)},${enable.toS.toFixed(3)})'`);
  return `drawbox=${parts.join(":")}`;
}

const RENDER_TIMEOUT_MS = 10_000;

/** 把框畫在一張 JPEG 上（ffmpeg，stdin 進 stdout 出）；不存檔，每次要就重畫 */
export async function drawBoxesOnJpeg(ffmpegBin: string, jpeg: Uint8Array, boxes: readonly EventBoxDto[]): Promise<Uint8Array<ArrayBuffer>> {
  const proc = Bun.spawn(
    [
      ffmpegBin,
      ...["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0"],
      ...["-vf", boxes.map((b) => drawbox(b)).join(","), "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
    ],
    { stdin: jpeg, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), RENDER_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 || out.length === 0) throw new Error(`ffmpeg drawbox exited ${code}: ${err.trim()}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
