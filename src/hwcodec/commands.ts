/**
 * ffmpeg 硬體解碼／編碼的參數，全部是純函式。每種 API 一列設定（`API`），呼叫端只拿 `HwApi`。
 *
 * 解碼一律加 `-hwaccel_output_format` 並在濾鏡開頭 `hwdownload`：硬體解碼失敗時 ffmpeg 會默默改用
 * 軟體解碼，送出系統記憶體的畫面，hwdownload 收不了就讓 ffmpeg 直接失敗。這樣「有在用顯示卡」
 * 才是可以檢查的事實，而不是只看指令有沒有帶參數。
 */

import { msg, zh, type Msg } from "../messages/index.ts";

export type CodecName = "h264" | "hevc";
export const CODECS: readonly CodecName[] = ["h264", "hevc"];
export const CODEC_LABEL: Record<CodecName, string> = { h264: "H.264", hevc: "H.265" };

/** ffmpeg 怎麼找到這張卡 */
export type HwApi =
  /** Intel：DRM render node，例如 /dev/dri/renderD128 */
  | { type: "vaapi"; node: string }
  /** Nvidia：有 UUID 時用 CUDA_VISIBLE_DEVICES 只露出這一張（不依賴編號順序）；沒有時依 PCI 順序的編號 */
  | { type: "cuda"; uuid: string | null; index: number }
  /** macOS 開發機：沒有裝置可選 */
  | { type: "videotoolbox" };

interface ApiSpec {
  hwaccel: string;
  outputFormat: string;
  encoder: Record<CodecName, string>;
}

const API: Record<HwApi["type"], ApiSpec> = {
  vaapi: { hwaccel: "vaapi", outputFormat: "vaapi", encoder: { h264: "h264_vaapi", hevc: "hevc_vaapi" } },
  cuda: { hwaccel: "cuda", outputFormat: "cuda", encoder: { h264: "h264_nvenc", hevc: "hevc_nvenc" } },
  videotoolbox: { hwaccel: "videotoolbox", outputFormat: "videotoolbox_vld", encoder: { h264: "h264_videotoolbox", hevc: "hevc_videotoolbox" } },
};

/** 8 位元的畫面是 nv12，10 位元的 H.265 是 p010 */
export const HW_DOWNLOAD = "hwdownload,format=nv12|p010le";

/** 子程序要多帶的環境變數 */
export function hwEnv(api: HwApi): Record<string, string> {
  if (api.type !== "cuda") return {};
  return api.uuid ? { CUDA_VISIBLE_DEVICES: api.uuid } : { CUDA_DEVICE_ORDER: "PCI_BUS_ID" };
}

function hwaccelDevice(api: HwApi): string | null {
  switch (api.type) {
    case "vaapi":
      return api.node;
    case "cuda":
      return api.uuid ? "0" : String(api.index);
    case "videotoolbox":
      return null;
  }
}

/**
 * 放在 `-i` 前面的解碼參數。`-threads 1`：ffmpeg 預設依核心數開解碼執行緒，硬體解碼時每條執行緒要多一個顯示卡上的畫面緩衝，
 * 而 NVDEC 最多 32 個（ffmpeg 7.1 的 decode.c `avcodec_get_hw_frames_parameters`、nvdec.c `ff_nvdec_decode_init`）。
 * 12 核心的主機開 13 條就超過，解碼器建立失敗。解碼在顯示卡上做，多開執行緒也省不到什麼。
 */
export function hwDecodeArgs(api: HwApi): string[] {
  const spec = API[api.type];
  const device = hwaccelDevice(api);
  return ["-threads", "1", "-hwaccel", spec.hwaccel, ...(device === null ? [] : ["-hwaccel_device", device]), "-hwaccel_output_format", spec.outputFormat];
}

export const encoderName = (api: HwApi, codec: CodecName) => API[api.type].encoder[codec];

const QUIET = ["-hide_banner", "-nostdin", "-loglevel", "error"];
const TEST_FRAMES = 10;
const TEST_SOURCE = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10"];

/**
 * 用 CPU 產生試跑用的短片（640×360、10 張，8 位元 4:2:0，和一般攝影機的子碼流同一類）。
 * 參考幀開到 8 張（libx265 在這個設定下的上限），顯示卡要準備的畫面緩衝不少於一般攝影機，
 * 緩衝不夠的問題在試跑就會出現，而不是試跑說可以、實際串流才失敗。H.264 不開到規格上限的 16 張：
 * 那樣離 NVDEC 的 32 個只剩一個，ffmpeg 多保留一點緩衝就會讓每台攝影機都只能用處理器。
 */
export function sampleCommand(ffmpeg: string, codec: CodecName, out: string): string[] {
  const enc = codec === "h264" ? ["-c:v", "libx264", "-refs", "8"] : ["-c:v", "libx265", "-x265-params", "log-level=error:ref=8"];
  return [ffmpeg, ...QUIET, ...TEST_SOURCE, "-frames:v", String(TEST_FRAMES), ...enc, "-pix_fmt", "yuv420p", "-y", out];
}

/** 試跑解碼：成功代表每一張都真的在這張卡上解出來（見檔案開頭） */
export function decodeTestCommand(ffmpeg: string, api: HwApi, sample: string): string[] {
  return [ffmpeg, ...QUIET, ...hwDecodeArgs(api), "-i", sample, "-vf", HW_DOWNLOAD, "-f", "null", "-"];
}

/** 試跑編碼：VAAPI 編碼器只收顯示卡上的畫面，要先 hwupload；NVENC 與 VideoToolbox 直接收系統記憶體的畫面 */
export function encodeTestCommand(ffmpeg: string, api: HwApi, codec: CodecName): string[] {
  const upload = api.type === "vaapi" ? ["-init_hw_device", `vaapi=hw:${api.node}`, "-filter_hw_device", "hw"] : [];
  const vf = api.type === "vaapi" ? "format=nv12,hwupload" : "format=nv12";
  return [ffmpeg, ...QUIET, ...upload, ...TEST_SOURCE, "-frames:v", String(TEST_FRAMES), "-vf", vf, "-c:v", encoderName(api, codec), "-f", "null", "-"];
}

export interface HwFailure {
  /** 給使用者看的一句話 */
  reason: string;
  /** reason 的訊息版本 */
  reasonMsg: Msg;
  /** ffmpeg 的原始訊息，進診斷資訊 */
  detail: string;
}

/** 試跑的是哪種格式的哪個動作；用在能力不足與無法判斷的原因（「H.265 硬體解碼」） */
export interface HwWhat {
  codec: CodecName;
  op: "decode" | "encode";
}

export const hwFailure = (reasonMsg: Msg, detail: string): HwFailure => ({ reason: zh(reasonMsg), reasonMsg, detail });
const whatParams = (w: HwWhat) => ({ codec: CODEC_LABEL[w.codec], op: w.op });
const node = (a: HwApi) => (a.type === "vaapi" ? a.node : "");

/** 依 ffmpeg 的錯誤訊息猜最可能的原因；猜不到就說哪一步失敗。順序是先環境（裝置、驅動），再能力不足，最後是解碼器建不起來 */
const RULES: { api?: HwApi["type"]; test: RegExp; msg: (api: HwApi, what: HwWhat) => Msg }[] = [
  { api: "vaapi", test: /No such file or directory|Device creation failed: -2\b/i, msg: (a) => msg("hw.noDriNode", { node: node(a) }) },
  // libva 只說開不了，不說是沒有節點還是沒權限；沒有節點的情況在列裝置時就擋掉了，所以多半是權限
  { api: "vaapi", test: /No VA display found/i, msg: (a) => msg("hw.cannotOpenGpu", { node: node(a) }) },
  { api: "vaapi", test: /Permission denied|Device creation failed: -13\b/i, msg: (a) => msg("hw.noPermission", { node: node(a) }) },
  { api: "vaapi", test: /va_openDriver\(\) returns|vaInitialize failed|Failed to initiali[sz]e VAAPI|libva: .*(not found|init failed)/i, msg: () => msg("hw.noVaDriver", {}) },
  { api: "cuda", test: /Cannot load libnvcuvid|Cannot load libnvidia-encode|nvcuvid|NvEncodeAPI|OpenEncodeSessionEx failed: unsupported device/i, msg: () => msg("hw.noNvidiaVideo", {}) },
  { api: "cuda", test: /Cannot load libcuda|cu->cuInit|CUDA_ERROR_NO_DEVICE|no CUDA-capable device/i, msg: () => msg("hw.noNvidiaDriver", {}) },
  { test: /No support for codec|not supported|Unsupported|lacking required capabilities|not within range|No usable encoding profile|does not support/i, msg: (_a, w) => msg("hw.unsupported", whatParams(w)) },
  { test: /cuvidCreateDecoder|decode surfaces|hwaccel initiali[sz]ation returned error|Failed setup for format/i, msg: (_a, w) => msg("hw.setupFailed", whatParams(w)) },
];

/** stderr 的最後幾行，夠判斷原因也不會把整段日誌塞進診斷資訊 */
export function stderrTail(stderr: string, lines = 6): string {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

export function explainHwFailure(api: HwApi, what: HwWhat, stderr: string, opts: { timedOut?: boolean; exitCode?: number | null } = {}): HwFailure {
  const detail = stderrTail(stderr) || (opts.timedOut ? "timed out" : `exit ${opts.exitCode ?? "?"}`);
  if (opts.timedOut) return hwFailure(msg("hw.timeout", whatParams(what)), detail);
  const rule = RULES.find((r) => (!r.api || r.api === api.type) && r.test.test(stderr));
  return hwFailure(rule ? rule.msg(api, what) : msg("hw.failed", whatParams(what)), detail);
}

const INPUT_FAILURE = /method \w+ failed|Server returned \d|Error opening input|Connection refused|Connection timed out|No route to host|Network is unreachable/i;
const HW_TRACE = /hwaccel|Failed setup for format|Device creation failed|cuvid|nvdec|CUDA_ERROR|libcuda|vaapi|VA display|libva|videotoolbox|hwdownload|Impossible to convert/i;

/**
 * 輸入端打不開（轉發層還沒有這條 path、相機連不上）：解碼器還沒開始，顯示卡根本沒試到，不算硬體失敗。
 * 有任何顯示卡相關的訊息就不算，寧可退回處理器也不讓真正的硬體問題一直重試。
 */
export function inputFailed(stderr: string): boolean {
  return INPUT_FAILURE.test(stderr) && !HW_TRACE.test(stderr);
}
