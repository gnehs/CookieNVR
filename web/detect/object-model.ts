import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
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
  return d.kind === "cpu" && !/cpu|處理器/i.test(name) ? t`CPU: ${name}` : name;
}

export interface DeviceOption {
  value: string;
  label: string;
}

/** 推論裝置選單：自動、偵測到的每個裝置；設定的裝置不在清單裡時補一項說明，免得選單顯示成別的東西 */
/** 同型號的卡用編號區分 */
export const indexedName = (name: string, index: number): string => t`${name} (${index})`;

export function deviceOptions(devices: readonly InferenceDeviceDto[], current: string): DeviceOption[] {
  const names = devices.map(deviceLabel);
  const options: DeviceOption[] = [{ value: AUTO_DEVICE, label: t`Auto (recommended)` }];
  devices.forEach((d, i) => {
    const same = names.filter((n) => n === names[i]).length > 1;
    options.push({ value: d.id, label: same ? indexedName(names[i]!, names.slice(0, i + 1).filter((n) => n === names[i]).length) : names[i]! });
  });
  if (current !== AUTO_DEVICE && !devices.some((d) => d.id === current)) options.push({ value: current, label: t`(not found right now, choosing automatically)` });
  return options;
}

export function deviceHint(current: string, devices: readonly InferenceDeviceDto[], active: InferenceDeviceDto | null): string {
  if (current === AUTO_DEVICE) {
    if (active) {
      const name = tidyName(active.name);
      return t`Chosen automatically: currently using ${name}. Uses a graphics card if one is available, otherwise the CPU.`;
    }
    return t`Uses a graphics card if one is available, otherwise the CPU. This is fine for most setups.`;
  }
  const d = devices.find((x) => x.id === current);
  if (!d) return t`The device you picked earlier can't be detected right now, so the system is choosing automatically. It switches back once the device returns.`;
  if (d.kind === "cpu") return t`Works on every computer, but struggles when detecting objects on several cameras at once.`;
  return t`A graphics card is faster at detecting objects and puts little load on the CPU.`;
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

const FPS_LABEL: Record<(typeof OBJECT_FPS_CHOICES)[number], MessageDescriptor> = {
  0.5: msg`Every 2 seconds`,
  1: msg`Once per second`,
  2: msg`Twice per second (recommended)`,
  3: msg`3 times per second`,
  5: msg`5 times per second`,
};

export const FPS_OPTIONS: { value: number; label: string }[] = OBJECT_FPS_CHOICES.map((v) => ({
  value: v,
  get label() {
    return i18n._(FPS_LABEL[v]);
  },
}));

/** 頻率越高，確認得越快，但越吃資源 */
export const FPS_HINT: MessageDescriptor = msg`More checks per second confirm what's in the picture sooner, but use more computer resources. The recommended value is fine for most setups.`;

/** 「每 2 秒 1 次」「每秒 2 次」，給句子裡用 */
export const rateText = (perSecond: number): string => {
  if (perSecond < 1) {
    const seconds = Math.round(1 / perSecond);
    return t`once every ${seconds} seconds`;
  }
  return plural(perSecond, { one: "# time per second", other: "# times per second" });
};

/** 「每秒辨識 2 次」「每 2 秒辨識 1 次」 */
export const rateClause = (perSecond: number): string => {
  if (perSecond < 1) {
    const seconds = Math.round(1 / perSecond);
    return t`detecting once every ${seconds} seconds`;
  }
  return plural(perSecond, { one: "detecting # time per second", other: "detecting # times per second" });
};

export const OBJECT_MODES: { value: ObjectMode; label: string; desc: string }[] = [
  {
    value: "off",
    get label() {
      return t`Off`;
    },
    get desc() {
      return t`Only detects whether there is motion, without working out what is in the picture.`;
    },
  },
  {
    value: "annotate",
    get label() {
      return t`Label`;
    },
    get desc() {
      return t`Events are recorded as usual and labeled with what was seen, such as "Person" or "Car".`;
    },
  },
  {
    value: "filter",
    get label() {
      return t`Filter`;
    },
    get desc() {
      return t`Only records events and sends notifications when a checked object is seen, so shadows, light changes and bugs won't bother you.`;
    },
  },
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

const STRICTNESS_TEXT: Record<Strictness, { word: MessageDescriptor; hint: MessageDescriptor }> = {
  loose: { word: msg`Loose`, hint: msg`Counts detections it isn't very sure about. Fewer misses, but more false alarms.` },
  normal: { word: msg`Standard`, hint: msg`The recommended value for most setups.` },
  strict: { word: msg`Strict`, hint: msg`Only counts what it is quite sure about. Fewer false alarms, but unclear objects may be missed.` },
  veryStrict: { word: msg`Very strict`, hint: msg`Needs an almost perfectly clear view. Distant or partly hidden objects are often missed.` },
};

export const STRICTNESS: Record<Strictness, { word: string; hint: string }> = Object.fromEntries(
  (Object.keys(STRICTNESS_TEXT) as Strictness[]).map((k) => [
    k,
    {
      get word() {
        return i18n._(STRICTNESS_TEXT[k].word);
      },
      get hint() {
        return i18n._(STRICTNESS_TEXT[k].hint);
      },
    },
  ]),
) as Record<Strictness, { word: string; hint: string }>;

/** 沒有勾任何類別時，過濾模式什麼事件都不會建立；標註模式則不會標上任何類別 */
export function labelsProblem(mode: ObjectMode, labels: readonly string[]): string | null {
  if (mode === "off" || labels.length > 0) return null;
  return mode === "filter" ? t`No categories are checked, so this camera won't record any events.` : t`No categories are checked, so events won't be labeled with what was seen.`;
}

export type ObjectsTone = "ok" | "warn" | "bad" | "busy";

/**
 * 顯示卡上的推論有多少其實在處理器上跑（顯示卡不支援的運算會交回處理器）。
 * 一成以下是正常的（形狀計算之類的小運算），不提；過半時速度其實是處理器的，要講清楚。
 */
export function cpuShareNote(share: number | null | undefined): { tone: "ok" | "warn"; text: string } | null {
  if (share === null || share === undefined || share < 0.1) return null;
  const pct = Math.round(share * 100);
  return share >= 0.5 ? { tone: "warn", text: t`Mostly runs on the CPU in practice (about ${pct}% of the work), so the graphics card helps little` } : { tone: "ok", text: t`${pct}% of the work runs on the CPU` };
}

/** 一句話裡幾段之間的分隔：「，」 */
export const listSeparator = (): string => t({ message: ", ", context: "clause separator" });

/** 句尾加句號 */
const sentence = (text: string): string => t`${text}.`;

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
  if (ms < 1) return t`Under 1 ms per frame on average`;
  const rounded = Math.round(ms);
  return t`${rounded} ms per frame on average`;
}

/**
 * 系統設定「物件辨識」目前的狀態。開關已經打開但程序還沒回報（off）也算啟動中。
 * 技術細節（fallback.detail、延遲、佇列）一律不在這裡出現，留給診斷資訊。
 */
export function objectsView(status: ObjectsStatusDto): ObjectsView {
  switch (status.state) {
    case "off":
    case "starting":
      return { tone: "busy", title: t`Starting…`, note: null, warnings: [] };
    case "loading":
      return { tone: "busy", title: t`Loading model…`, note: t`The first time a graphics card is used, this can take about a minute.`, warnings: [] };
    case "error":
      return { tone: "bad", title: t`Model unavailable`, note: status.error ?? t`Try a different model.`, warnings: [] };
    case "ready": {
      if (status.paused === "benchmark") return { tone: "busy", title: t`Benchmarking, detection paused`, note: t`Events are still recorded and detection resumes when the test finishes.`, warnings: [] };
      const share = cpuShareNote(status.cpuShare);
      const deviceName = status.device ? tidyName(status.device.name) : t`CPU`;
      const warnings = [status.fallback?.reason, share?.tone === "warn" ? sentence(share.text) : null, status.warning].filter((w): w is string => !!w);
      const note = [speedText(status), share?.tone === "ok" ? share.text : null].filter(Boolean).join(listSeparator());
      return {
        tone: warnings.length ? "warn" : "ok",
        title: t`In use: ${deviceName}`,
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

/**
 * 事件頁類別篩選的選項：只列攝影機有開啟的類別，加上事件裡實際出現過的；模型支援但沒人開的不列。
 * seen 每個事件的每個類別各給一次（重複即次數），依出現次數由多到少排；次數相同照目錄順序，事件裡另外出現的（相機自己回報的 vehicle、pet，或之後關掉的類別）排在同次數的最後。
 */
export function eventLabelOptions(catalog: Pick<ObjectLabelsDto, "labels"> | null, enabled: Iterable<string>, seen: Iterable<string>): { key: string; zh: string }[] {
  const zh = new Map((catalog?.labels ?? []).map((l) => [l.key, l.zh]));
  const on = new Set(enabled);
  const count = new Map<string, number>();
  for (const key of seen) count.set(key, (count.get(key) ?? 0) + 1);
  const ordered = (catalog?.labels ?? []).filter((l) => on.has(l.key)).map((l) => l.key);
  return [...new Set([...ordered, ...on, ...count.keys()])]
    .sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0))
    .map((key) => ({ key, zh: zh.get(key) ?? labelName(key) }));
}


/** 卡片收合時的摘要：「辨識人與汽車」「只記錄人、汽車與貓」；不辨識就沒有 */
export function objectSummary(mode: ObjectMode, labels: readonly string[]): string | null {
  if (mode === "off") return null;
  const names = [...new Set(labels.map(labelName))];
  if (names.length === 0) return mode === "filter" ? t`No categories selected, no events recorded` : t`Detect objects`;
  const list = names.length <= 3 ? listNames(names) : etcNames(names);
  return mode === "filter" ? t`Only record ${list}` : t`Detect ${list}`;
}

/** 「人」「人與汽車」「人、汽車與狗」 */
function listNames(names: readonly string[]): string {
  const [first, second, third] = names as [string, string?, string?];
  if (second === undefined) return first;
  if (third === undefined) return t`${first} and ${second}`;
  return t`${first}, ${second} and ${third}`;
}

/** 「人、汽車等 4 類」 */
function etcNames(names: readonly string[]): string {
  const [first, second] = names as [string, string];
  const total = names.length;
  return t`${first}, ${second}, etc. (${total} categories)`;
}
