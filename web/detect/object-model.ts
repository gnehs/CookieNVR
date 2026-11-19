import type { InferenceDeviceKind, ObjectsStatusDto } from "../../src/api-types.ts";
import { LIMITS } from "../../src/detect/config.ts";
import type { InferenceDevice, ObjectMode } from "../../src/types.ts";

export const DEVICE_NAME: Record<InferenceDeviceKind, string> = { cpu: "CPU", intel: "Intel 內顯", nvidia: "Nvidia 顯卡" };

export const DEVICE_CHOICES: { value: InferenceDevice; label: string }[] = [
  { value: "auto", label: "自動" },
  { value: "cpu", label: "CPU" },
  { value: "intel", label: "Intel 內顯" },
  { value: "nvidia", label: "Nvidia 顯卡" },
];

export const DEVICE_HINT: Record<InferenceDevice, string> = {
  auto: "有可用的顯卡就用顯卡，沒有就用 CPU。大多數情況選這個就好。",
  cpu: "每台電腦都能用，但同時辨識多台攝影機時會比較吃力。",
  intel: "用 Intel 處理器內建的顯示晶片辨識，省電也不太佔用 CPU。",
  nvidia: "用 Nvidia 顯卡辨識，速度最快。需要在 Docker 裡開放顯卡給 CookieNVR 使用。",
};

export const OBJECT_MODES: { value: ObjectMode; label: string; desc: string }[] = [
  { value: "off", label: "不辨識", desc: "只偵測有沒有動作，不判斷畫面裡是什麼。" },
  { value: "annotate", label: "標註", desc: "事件照常記錄，並標上看到了什麼，例如「人」或「汽車」。" },
  { value: "filter", label: "過濾", desc: "只在看到勾選的東西時才記錄事件與通知，樹影、光線和小蟲都不會吵你。" },
];

export const modeOf = (v: string): ObjectMode => OBJECT_MODES.find((m) => m.value === v)?.value ?? "annotate";

/** 嚴格程度滑桿：0 到 100 對應信心門檻 0.3 到 0.95，每 5% 一格 */
const { min: SCORE_MIN, max: SCORE_MAX } = LIMITS.objectScore;
export const scoreToPos = (score: number) => Math.round(Math.min(100, Math.max(0, ((score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100)) * 2) / 2;
export function posToScore(pos: number): number {
  const raw = SCORE_MIN + (Math.min(100, Math.max(0, pos)) / 100) * (SCORE_MAX - SCORE_MIN);
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(raw * 20) / 20));
}

export type Strictness = "loose" | "normal" | "strict" | "veryStrict";

export function strictnessOf(score: number): Strictness {
  if (score < 0.45) return "loose";
  if (score < 0.6) return "normal";
  if (score < 0.8) return "strict";
  return "veryStrict";
}

export const STRICTNESS: Record<Strictness, { word: string; hint: string }> = {
  loose: { word: "寬鬆", hint: "不太確定的也算，比較不會漏掉，但可能多一些誤判。" },
  normal: { word: "標準", hint: "大多數情況的建議值。" },
  strict: { word: "嚴格", hint: "要很確定才算，誤判比較少，但看不清楚的可能會漏掉。" },
  veryStrict: { word: "非常嚴格", hint: "幾乎要看得一清二楚才算，常常會漏掉遠處或被擋住的。" },
};

/** 沒有勾任何類別時，過濾模式什麼事件都不會建立；標註模式則不會標上任何類別 */
export function labelsProblem(mode: ObjectMode, labels: readonly string[]): string | null {
  if (mode === "off" || labels.length > 0) return null;
  return mode === "filter" ? "還沒有勾選任何類別，這台不會記錄任何事件。" : "還沒有勾選任何類別，事件不會標上看到的東西。";
}

export type ObjectsTone = "ok" | "warn" | "bad" | "busy";

export interface ObjectsView {
  tone: ObjectsTone;
  /** 狀態一行，例如「使用中：Intel 內顯」 */
  title: string;
  /** 一句補充，沒有就是 null */
  note: string | null;
  /** 退回 CPU 的原因（使用者看得懂的中文） */
  warning: string | null;
}

/** 平均每張的耗時：一般人看得懂的一句話；還沒推論過、或數字沒意義就沒有 */
export function speedText(status: Pick<ObjectsStatusDto, "latencyMs">): string | null {
  const ms = status.latencyMs?.avg;
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  return ms < 1 ? "每張不到 1 毫秒" : `每張約 ${Math.round(ms)} 毫秒`;
}

/**
 * 系統設定「物件辨識」目前的狀態。開關已經打開但程序還沒回報（off）也算啟動中。
 * 技術細節（fallback.detail、延遲、佇列）一律不在這裡出現，留給診斷資訊。
 */
export function objectsView(status: ObjectsStatusDto): ObjectsView {
  switch (status.state) {
    case "off":
    case "starting":
      return { tone: "busy", title: "啟動中…", note: null, warning: null };
    case "loading":
      return { tone: "busy", title: "載入模型中…", note: "第一次使用顯卡時，可能需要等一分鐘左右。", warning: null };
    case "error":
      return { tone: "bad", title: "模型無法使用", note: status.error ?? "請換一個模型試試。", warning: null };
    case "ready": {
      const device = status.device ? DEVICE_NAME[status.device] : "CPU";
      return {
        tone: status.fallback ? "warn" : "ok",
        title: `使用中：${device}`,
        note: speedText(status),
        warning: status.fallback ? status.fallback.reason : null,
      };
    }
  }
}
