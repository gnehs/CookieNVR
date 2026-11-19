import { HW_DOWNLOAD, hwDecodeArgs, hwEnv } from "../hwcodec/commands.ts";
import type { HwDecode } from "../hwcodec/plan.ts";
import { FRAME_H, FRAME_W } from "./motion.ts";

/** detect worker 由這個環境變數收到硬體解碼的設定（JSON 的 HwDecode）；沒有就是 CPU */
export const HW_DECODE_ENV = "DETECT_HW_DECODE";

/**
 * 一次解碼、兩路輸出：每秒 5 張 320×180 灰階 raw（stdout）與 640 寬 JPEG（fd 3）。
 * 硬體解碼時 fps 放在 hwdownload 前面，每秒只有 5 張從顯示卡搬回系統記憶體；也不帶 `-fflags nobuffer`：
 * 實測 VideoToolbox 在 nobuffer 下對同一條 RTSP 每張都解碼失敗（-12909）而且 ffmpeg 不會結束，
 * 其他 API 沒能實測，一併拿掉。它只省開頭探測時的緩衝，對動作偵測的延遲影響很小。
 */
export function detectCommand(ffmpeg: string, input: string, jpegFps: number, hw: HwDecode | null): { cmd: string[]; env: Record<string, string> } {
  const head = hw ? `[0:v:0]fps=5,${HW_DOWNLOAD},` : "[0:v:0]fps=5,";
  return {
    cmd: [
      ffmpeg,
      ...["-hide_banner", "-nostdin", "-loglevel", "warning"],
      ...(hw ? [] : ["-fflags", "nobuffer"]),
      ...["-probesize", "500000", "-analyzeduration", "500000"],
      ...(hw ? hwDecodeArgs(hw.api) : []),
      ...["-rtsp_transport", "tcp", "-timeout", "10000000", "-i", input],
      "-filter_complex",
      `${head}scale=640:-2,split=2[a][b];[a]scale=${FRAME_W}:${FRAME_H},format=gray[g];[b]fps=${jpegFps}[j]`,
      ...["-map", "[g]", "-f", "rawvideo", "pipe:1"],
      ...["-map", "[j]", "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "pipe:3"],
    ],
    env: hw ? hwEnv(hw.api) : {},
  };
}

/** 環境變數裡的 HwDecode；看不懂就當作 CPU，不讓 worker 因為設定壞掉而起不來 */
export function parseHwDecode(raw: string | undefined): HwDecode | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as HwDecode;
    const t = v?.api?.type;
    if (typeof v.deviceId !== "string" || (t !== "vaapi" && t !== "cuda" && t !== "videotoolbox")) return null;
    return v;
  } catch {
    return null;
  }
}
