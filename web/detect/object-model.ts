import type { InferenceDeviceDto, ObjectLabelsDto, ObjectsDto, ObjectsStatusDto } from "../../src/api-types.ts";
import { LIMITS } from "../../src/detect/config.ts";
import { labelName } from "../../src/objects/labels.ts";
import { OBJECT_FPS_CHOICES, type ObjectMode } from "../../src/types.ts";

export const AUTO_DEVICE = "auto";

/** 「Intel(R) UHD Graphics 630」→「Intel UHD Graphics 630」：商標符號只會讓選單變長 */
export const tidyName = (name: string): string => name.replace(/\((?:R|TM|tm|r)\)/g, "").replace(/\s{2,}/g, " ").trim();

/** 選單上的一個裝置：型號；CPU 加上前綴，讓人一眼知道是處理器 */
export function deviceLabel(d: InferenceDeviceDto): string {
  const name = tidyName(d.name);
  return d.kind === "cpu" && !/cpu|處理器/i.test(name) ? `處理器：${name}` : name;
}

export interface DeviceOption {
  value: string;
  label: string;
}

/** 推論裝置選單：自動、偵測到的每個裝置；設定的裝置不在清單裡時補一項說明，免得選單顯示成別的東西 */
export function deviceOptions(devices: readonly InferenceDeviceDto[], current: string): DeviceOption[] {
  const names = devices.map(deviceLabel);
  const options: DeviceOption[] = [{ value: AUTO_DEVICE, label: "自動（建議）" }];
  devices.forEach((d, i) => {
    const same = names.filter((n) => n === names[i]).length > 1;
    options.push({ value: d.id, label: same ? `${names[i]}（${names.slice(0, i + 1).filter((n) => n === names[i]).length}）` : names[i]! });
  });
  if (current !== AUTO_DEVICE && !devices.some((d) => d.id === current)) options.push({ value: current, label: "（目前找不到，暫時自動選擇）" });
  return options;
}

export function deviceHint(current: string, devices: readonly InferenceDeviceDto[], active: InferenceDeviceDto | null): string {
  if (current === AUTO_DEVICE) return active ? `自動選擇：目前用的是 ${tidyName(active.name)}。有可用的顯卡就用顯卡，沒有就用處理器。` : "有可用的顯卡就用顯卡，沒有就用處理器。大多數情況選這個就好。";
  const d = devices.find((x) => x.id === current);
  if (!d) return "之前選的裝置現在偵測不到，暫時由系統自動選擇。裝置回來後會自動改回去。";
  if (d.kind === "cpu") return "每台電腦都能用，但同時辨識多台攝影機時會比較吃力。";
  return "顯卡辨識得比較快，也不太佔用處理器。";
}

/** 某類裝置不能用的原因：使用者指定了那類裝置時直接顯示，其餘收起來，免得每台機器都堆著用不到的說明 */
export function unavailableNotes(unavailable: ObjectsDto["unavailable"], current: string): { inline: string[]; folded: string[] } {
  const inline: string[] = [];
  const folded: string[] = [];
  for (const kind of ["intel", "nvidia"] as const) {
    const reason = unavailable[kind];
    if (!reason) continue;
    (current.startsWith(`${kind}:`) ? inline : folded).push(reason);
  }
  return { inline, folded };
}

const FPS_LABEL: Record<(typeof OBJECT_FPS_CHOICES)[number], string> = { 0.5: "每 2 秒 1 次", 1: "每秒 1 次", 2: "每秒 2 次（建議）", 3: "每秒 3 次", 5: "每秒 5 次" };

export const FPS_OPTIONS: { value: number; label: string }[] = OBJECT_FPS_CHOICES.map((v) => ({ value: v, label: FPS_LABEL[v] }));

/** 頻率越高，確認得越快，但越吃資源 */
export const FPS_HINT = "次數越多，越快確認畫面裡是什麼，但也越吃電腦資源。大多數情況維持建議值就好。";

/** 「每秒 2 次」「每 2 秒 1 次」，給句子裡用 */
export const rateText = (perSecond: number): string => (perSecond < 1 ? `每 ${Math.round(1 / perSecond)} 秒 1 次` : `每秒 ${perSecond} 次`);

/** 「每秒辨識 2 次」「每 2 秒辨識 1 次」 */
export const rateClause = (perSecond: number): string => (perSecond < 1 ? `每 ${Math.round(1 / perSecond)} 秒辨識 1 次` : `每秒辨識 ${perSecond} 次`);

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

/**
 * 顯示卡上的推論有多少其實在處理器上跑（顯示卡不支援的運算會交回處理器）。
 * 一成以下是正常的（形狀計算之類的小運算），不提；過半時速度其實是處理器的，要講清楚。
 */
export function cpuShareNote(share: number | null | undefined): { tone: "ok" | "warn"; text: string } | null {
  if (share === null || share === undefined || share < 0.1) return null;
  const pct = Math.round(share * 100);
  return share >= 0.5 ? { tone: "warn", text: `實際上大多在處理器上執行（約 ${pct}% 的運算），顯示卡幫助不大` } : { tone: "ok", text: `約 ${pct}% 的運算在處理器上執行` };
}

export interface ObjectsView {
  tone: ObjectsTone;
  /** 狀態一行，例如「使用中：Intel UHD Graphics 630」 */
  title: string;
  /** 一句補充，沒有就是 null */
  note: string | null;
  /** 需要注意的事（使用者看得懂的中文）：退回別的裝置、負載太高 */
  warnings: string[];
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
      return { tone: "busy", title: "啟動中…", note: null, warnings: [] };
    case "loading":
      return { tone: "busy", title: "載入模型中…", note: "第一次使用顯卡時，可能需要等一分鐘左右。", warnings: [] };
    case "error":
      return { tone: "bad", title: "模型無法使用", note: status.error ?? "請換一個模型試試。", warnings: [] };
    case "ready": {
      if (status.paused === "benchmark") return { tone: "busy", title: "測速中，暫停辨識", note: "事件照常記錄，測完會自動恢復。", warnings: [] };
      const share = cpuShareNote(status.cpuShare);
      const warnings = [status.fallback?.reason, share?.tone === "warn" ? `${share.text}。` : null, status.warning].filter((w): w is string => !!w);
      const note = [speedText(status), share?.tone === "ok" ? share.text : null].filter(Boolean).join("，");
      return {
        tone: warnings.length ? "warn" : "ok",
        title: `使用中：${status.device ? tidyName(status.device.name) : "處理器"}`,
        note: note || null,
        warnings,
      };
    }
  }
}

/** 類別勾選：預設列出 common，其餘收在「更多類別」；已勾選但不在目前模型裡的類別（換過模型）也留在清單上，才取消得掉 */
export interface LabelGroups {
  common: { key: string; zh: string }[];
  more: { key: string; zh: string }[];
  /** 「更多類別」裡有已勾選的，預設展開 */
  moreHasSelected: boolean;
  /** 目前模型沒有「包裹」類別 */
  noPackage: boolean;
}

export function labelGroups(catalog: Pick<ObjectLabelsDto, "labels" | "common"> | null, selected: readonly string[]): LabelGroups {
  const labels = catalog?.labels ?? [];
  const byKey = new Map(labels.map((l) => [l.key, l.zh]));
  const commonKeys = (catalog?.common ?? []).filter((k) => byKey.has(k));
  const orphan = selected.filter((k) => !byKey.has(k));
  const shown = new Set([...commonKeys, ...orphan]);
  const more = labels.filter((l) => !shown.has(l.key)).map((l) => ({ key: l.key, zh: l.zh }));
  const sel = new Set(selected);
  return {
    common: [...commonKeys, ...orphan].map((key) => ({ key, zh: byKey.get(key) ?? labelName(key) })),
    more,
    moreHasSelected: more.some((l) => sel.has(l.key)),
    noPackage: !!catalog && !byKey.has("package") && !byKey.has("parcel"),
  };
}

/** 事件頁類別篩選的選項：模型的常用類別與事件裡出現過的（含相機自己的 vehicle、pet）放前面，其餘類別在後 */
export function eventLabelOptions(catalog: Pick<ObjectLabelsDto, "labels" | "common"> | null, seen: Iterable<string>): { top: { key: string; zh: string }[]; rest: { key: string; zh: string }[] } {
  const zh = new Map((catalog?.labels ?? []).map((l) => [l.key, l.zh]));
  const topKeys = [...new Set([...(catalog?.common ?? []), ...seen])];
  const top = topKeys.map((key) => ({ key, zh: zh.get(key) ?? labelName(key) }));
  const taken = new Set(topKeys);
  const rest = (catalog?.labels ?? []).filter((l) => !taken.has(l.key)).map((l) => ({ key: l.key, zh: l.zh }));
  return { top, rest };
}


/** 卡片收合時的摘要：「辨識人與汽車」「只記錄人、汽車與貓」；不辨識就沒有 */
export function objectSummary(mode: ObjectMode, labels: readonly string[]): string | null {
  if (mode === "off") return null;
  const names = [...new Set(labels.map(labelName))];
  if (names.length === 0) return mode === "filter" ? "未選類別，不記錄事件" : "辨識物件";
  const list = names.length <= 3 ? (names.length === 1 ? names[0]! : `${names.slice(0, -1).join("、")}與${names.at(-1)}`) : `${names.slice(0, 2).join("、")}等 ${names.length} 類`;
  return `${mode === "filter" ? "只記錄" : "辨識"}${list}`;
}
