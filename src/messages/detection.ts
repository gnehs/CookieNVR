import type { MsgTable } from "./index.ts";

/**
 * 影像解碼失敗原因（src/hwcodec）共用的參數：所有欄位都可省略。
 * - node：裝置節點（/dev/dri/renderD128）
 * - codec / op：試跑的影像格式（H.264、H.265）與動作（decode、encode）
 * - device：自動選擇全部失敗時，原因前面加上的顯示卡名稱
 * - forCodec：使用者指定的卡不能解這個格式時，原因後面加上的格式
 */
export type HwParams = { node?: string; codec?: string; op?: string; device?: string; forCodec?: string };
/** 解碼提醒：哪一台（camera）或幾台（count）攝影機，加上 `reason` 指向的 hw.* 原因（參數同 HwParams；raw 的話原文在 text） */
export type DecodeWarnParams = HwParams & { camera?: string; count?: number; reason: string; text?: string };

// device 與 forCodec 不會同時出現；前者加在前面，後者加在後面
const wrap = (p: HwParams, text: string) => (p.device ? `${p.device}：${text}` : p.forCodec ? `${text}（${p.forCodec}）` : text);
const what = (p: HwParams) => `${p.codec ?? ""} 硬體${p.op === "encode" ? "編碼" : "解碼"}`;

/** 可以進失敗原因的 hw.* 訊息 */
export const hwReasons = {
  "hw.noDriNode": (p: HwParams) => wrap(p, `容器裡沒有這張顯示卡的裝置（${p.node ?? ""}），請在容器設定掛入 /dev/dri`),
  "hw.cannotOpenGpu": (p: HwParams) => wrap(p, `無法開啟顯示卡（${p.node ?? ""}）：確認容器掛入了 /dev/dri，而且加入了主機的 render 群組`),
  "hw.noPermission": (p: HwParams) => wrap(p, `沒有權限使用顯示卡（${p.node ?? ""}），請把容器加入主機的 render 群組`),
  "hw.noVaDriver": (p: HwParams) => wrap(p, "找不到 Intel 的影像驅動程式（VAAPI），映像可能缺少 intel-media-va-driver"),
  "hw.noNvidiaVideo": (p: HwParams) => wrap(p, "容器沒有載入 Nvidia 的影像編解碼元件，容器設定的 NVIDIA_DRIVER_CAPABILITIES 需要包含 video"),
  "hw.noNvidiaDriver": (p: HwParams) => wrap(p, "容器裡沒有 Nvidia 驅動程式，請用 NVIDIA Container Toolkit 啟動容器"),
  "hw.unsupported": (p: HwParams) => wrap(p, `這張顯示卡不支援 ${what(p)}`),
  "hw.setupFailed": (p: HwParams) => wrap(p, `顯示卡啟動 ${what(p)}失敗`),
  "hw.timeout": (p: HwParams) => wrap(p, `顯示卡沒有在時限內完成 ${what(p)}`),
  "hw.failed": (p: HwParams) => wrap(p, `顯示卡沒有完成 ${what(p)}`),
  "hw.sampleFailed": (p: HwParams) => wrap(p, `無法產生 ${p.codec ?? ""} 的試跑影片（這個 ffmpeg 可能沒有軟體編碼器）`),
  "hw.nodeMissing": (p: HwParams) => wrap(p, `主機有這張 Intel 顯示卡，但容器裡沒有 ${p.node ?? ""}：請在容器設定掛入 /dev/dri`),
  "hw.deviceGone": (p: HwParams) => wrap(p, "找不到設定的顯示卡（可能拔掉或換了），已改用自動選擇"),
} satisfies MsgTable;

export type HwCode = keyof typeof hwReasons;

/** 解碼提醒裡的原因：`reason` 是 hw.* code，其餘參數同 HwParams；不認得就空字串 */
export function hwReasonText(p: DecodeWarnParams): string {
  if (p.reason === "raw") return p.text ?? "";
  const fn = (hwReasons as Record<string, ((p: HwParams) => string) | undefined>)[p.reason];
  return fn ? fn(p) : "";
}

const GPU_ITEMS: Record<string, string> = { utilization: "使用率", memory: "顯示記憶體", temperature: "溫度" };

export const detection = {
  ...hwReasons,
  "decode.warningCpu": (p: DecodeWarnParams) => `${p.camera ?? `${p.count ?? 0} 台攝影機`}改用處理器解碼：${hwReasonText(p)}`,
  "decode.warningMoved": (p: DecodeWarnParams) => `${p.camera ?? `${p.count ?? 0} 台攝影機`}沒有用設定的顯示卡解碼：${hwReasonText(p)}`,

  "objects.notReady": () => "物件辨識還沒準備好，開啟並等它載入完成後再測速",
  "objects.benchRunning": () => "測速正在進行中",
  "objects.unknownDevices": ({ devices }: { devices: string[] }) => `找不到這些裝置：${devices.join("、")}`,
  "objects.dropWarning": ({ percent }: { percent: number }) => `最近有 ${percent}% 的畫面來不及辨識。可以降低辨識頻率，或改用更快的裝置。`,
  "objects.capacityWarning": ({ cameras, supported }: { cameras: number; supported: number }) =>
    `開了物件辨識的 ${cameras} 台攝影機同時有動作時會來不及，這台機器大約能同時處理 ${supported} 台。可以降低辨識頻率，或改用更快的裝置。`,
  "objects.benchInterrupted": () => "推論程序重新啟動，測速中斷",
  "objects.gpuLabel": () => "物件辨識",
  "objects.gpuBenchmarking": () => "測速中",
  "objects.gpuRate": ({ fps }: { fps: number }) => `每秒 ${fps} 張`,

  "gpu.notProvided": ({ items }: { items: string[] }) => `這張顯示卡不提供${items.map((i) => GPU_ITEMS[i] ?? i).join("、")}`,
  "gpu.noUtilization": () => "這個 GPU 不提供使用率",

  // detector（Python）回報的原因；detector/engine.py、main.py、yolo.py 送 code 與 params，文字要和那邊的中文一致
  "detector.noIntelRuntime": () => "這個映像沒有 Intel 內顯推論元件（只有 amd64 的映像有）",
  "detector.noDri": () => "容器裡找不到 Intel 內顯（/dev/dri），請在容器設定掛入 /dev/dri",
  "detector.driNoAccess": () => "沒有權限使用 /dev/dri，請把容器加入主機 render 群組（--group-add）",
  "detector.byPathMissing": () => "Intel 內顯缺少 /dev/dri/by-path 連結，OpenVINO 找不到它；請以 root 啟動容器（可用 PUID／PGID 降權）讓 CookieNVR 自動補上",
  "detector.openvinoNoGpu": () => "OpenVINO 看不到 Intel 內顯，可能是驅動不支援這顆內顯",
  "detector.noNvidiaRuntime": () => "這個映像沒有 Nvidia 推論元件，請改用 latest-nvidia 映像",
  "detector.noNvidiaGpu": () => "容器裡看不到 Nvidia 顯卡，請確認主機已裝 NVIDIA Container Toolkit，並以 --gpus all 或 runtime: nvidia 啟動",
  "detector.noIntelDetected": () => "沒有偵測到Intel 內顯",
  "detector.noNvidiaDetected": () => "沒有偵測到Nvidia 顯卡",
  "detector.deviceGone": () => "指定的裝置目前找不到（可能已拔除或換了顯示卡），已改用自動選擇",
  "detector.notOnDevice": ({ device, runtime }: { device: string; runtime: string }) => `${device} 沒有實際執行這個模型（${runtime} 把運算交回處理器），已改用其他裝置`,
  "detector.notOnDeviceBench": ({ device, runtime }: { device: string; runtime: string }) => `${device} 沒有實際執行這個模型（${runtime} 把運算交回處理器），這個裝置不適合用來辨識`,
  "detector.loadFailed": ({ device }: { device: string }) => `${device}載入模型失敗，已改用其他裝置`,
  "detector.benchDeviceMissing": () => "找不到這個裝置",
  "detector.modelLoadFailed": () => "模型載入失敗",
  "detector.modelNotOnnx": () => "無法載入模型，檔案可能不是有效的 ONNX 模型",
  "detector.modelFileMissing": ({ file }: { file: string }) => `找不到模型檔 ${file}`,
  "detector.modelInputShape": ({ shape }: { shape: string }) => `模型的輸入應該是 [1, 3, 高, 寬] 的影像，這個模型是 ${shape}`,
  "detector.modelInputSize": ({ width, height }: { width: number; height: number }) => `模型的輸入尺寸 ${width}×${height} 不是 32 的倍數，看起來不是 YOLO 模型`,
  "detector.modelNoClassNames": ({ count }: { count: number }) => `模型有 ${count} 個類別，但沒有附類別名稱；目前只支援 COCO 80 類或在 metadata 帶 names 的模型`,
  "detector.modelOutputShape": ({ shape }: { shape: string }) => `看不懂模型的輸出形狀 ${shape}；支援 YOLOX（[1, N, 85]）、Ultralytics YOLOv8 / 11（[1, 84, N]）與內含 NMS 的 [1, K, 6]`,
  "detector.modelOutputGrid": ({ shape, width, height, expected }: { shape: string; width: number; height: number; expected: number }) =>
    `看不懂模型的輸出形狀 ${shape}（輸入 ${width}×${height}，格點應有 ${expected} 個）；支援 YOLOX（[1, N, 85]）、Ultralytics YOLOv8 / 11（[1, 84, N]）與內含 NMS 的 [1, K, 6]`,
  "detector.modelInputCount": ({ count }: { count: number }) => `模型應該只有一個影像輸入，這個模型有 ${count} 個`,
  "detector.modelInputType": ({ type }: { type: string }) => `模型的輸入型別是 ${type}，目前只支援 float32`,
} satisfies MsgTable;
