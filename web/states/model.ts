import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
import { MIN_STATE_IMAGES_PER_CLASS, type CropBox, type FrigateConfigResultDto, type StateModelDto, type StateSensorDto } from "../../src/api-types.ts";

// 狀態辨識介面的純邏輯：驗證、狀態文字、訓練進度與結果的白話說法、類別編輯的計畫、框選區域的幾何。
// 驗證規則照 src/states/config.ts（後端仍會再檢查一次）。

/** 新感應器預設的兩個類別名稱：用目前的語言 */
export const defaultClasses = (): string[] => [t`Closed`, t`Open`];
export const MAX_CLASSES = 10;
export const MAX_NAME = 40;
export const MAX_CLASS_NAME = 32;

export function sensorNameError(name: string): string | null {
  const s = name.trim();
  if (!s) return t`Give it a name, for example “Roller shutter”`;
  if (s.length > MAX_NAME) {
    const max = MAX_NAME;
    return t`Names can be at most ${max} characters`;
  }
  return null;
}

export function classNameError(name: string): string | null {
  const s = name.trim();
  if (!s) return t`Class names can't be empty`;
  if (s.length > MAX_CLASS_NAME) {
    const max = MAX_CLASS_NAME;
    return t`Class names can be at most ${max} characters`;
  }
  if (/[/\\]/.test(s)) return t`Class names can't contain a slash or backslash`;
  if (s.startsWith(".")) return t`Class names can't start with a dot`;
  return null;
}

/** 整組類別：每一個都合法、不重複、2 到 10 個；回傳第一個問題 */
export function classesError(names: readonly string[]): { index: number | null; message: string } | null {
  for (const [i, n] of names.entries()) {
    const e = classNameError(n);
    if (e) return { index: i, message: e };
    if (names.slice(0, i).some((m) => m.trim() === n.trim())) {
      const name = n.trim();
      return { index: i, message: t`“${name}” is used twice` };
    }
  }
  if (names.length < 2) return { index: null, message: t`Add at least 2 classes` };
  if (names.length > MAX_CLASSES) {
    const max = MAX_CLASSES;
    return { index: null, message: t`At most ${max} classes` };
  }
  return null;
}

// ─── 目前狀態 ───

/** 感應器此刻的樣子：照優先順序只取一種，畫面上的文字與色調都從這裡來 */
export type SensorView =
  | { kind: "state"; label: string; since: number; candidate: string | null }
  | { kind: "confirming"; candidate: string | null }
  | { kind: "paused"; message: string }
  | { kind: "problem"; code: Exclude<NonNullable<StateSensorDto["problem"]>["code"], "disabled" | "paused">; message: string };

export function sensorView(s: StateSensorDto): SensorView {
  const p = s.problem;
  if (p?.code === "disabled") return { kind: "paused", message: t`Detection paused` };
  if (p?.code === "paused") return { kind: "paused", message: p.message };
  if (p) return { kind: "problem", code: p.code, message: p.message };
  const candidate = s.candidate && s.candidate.label !== s.state ? s.candidate.label : null;
  if (s.state !== null && s.since !== null) return { kind: "state", label: s.state, since: s.since, candidate };
  return { kind: "confirming", candidate };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 「剛剛」「12 分鐘前」「3 小時前」「昨天 14:05」「11/18 14:05」 */
export function sinceText(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return t`Just now`;
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    return plural(minutes, { one: "# minute ago", other: "# minutes ago" });
  }
  const d = new Date(at);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (diff < 6 * 3_600_000 && at >= today.getTime()) {
    const hours = Math.floor(diff / 3_600_000);
    return plural(hours, { one: "# hour ago", other: "# hours ago" });
  }
  if (at >= today.getTime()) return t`Today ${clock}`;
  if (at >= today.getTime() - 86_400_000) return t`Yesterday ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

/** 一行的狀態說明（不含名稱）：「開 · 12 分鐘前」「確認中…」「還沒訓練」 */
export function stateText(v: SensorView, now = Date.now()): string {
  switch (v.kind) {
    case "state":
      return `${v.label} · ${sinceText(v.since, now)}`;
    case "confirming":
      if (v.candidate) {
        const candidate = v.candidate;
        return t`Confirming: ${candidate}`;
      }
      return t`Confirming…`;
    case "paused":
      return v.message;
    case "problem":
      return i18n._(PROBLEM_SHORT[v.code]);
  }
}

const PROBLEM_SHORT: Record<Extract<SensorView, { kind: "problem" }>["code"], MessageDescriptor> = {
  untrained: msg`Not trained yet`,
  "stale-model": msg`Needs retraining`,
  "camera-off": msg`No picture`,
  worker: msg`Detection isn't running`,
};

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

export function viewTone(v: SensorView): Tone {
  if (v.kind === "state") return "accent";
  if (v.kind === "confirming" || v.kind === "paused") return "muted";
  return v.code === "worker" ? "bad" : "warn";
}

// ─── 標記與訓練 ───

export interface ClassNeed {
  label: string;
  count: number;
  /** 還差幾張才能訓練 */
  missing: number;
}

export function classNeeds(s: StateSensorDto): ClassNeed[] {
  return s.images.labeled.map((l) => ({ ...l, missing: Math.max(0, MIN_STATE_IMAGES_PER_CLASS - l.count) }));
}

/** 「還需要：開 2 張、移動中 1 張」；夠了是 null */
export function needsText(s: StateSensorDto): string | null {
  const lacking = classNeeds(s).filter((c) => c.missing > 0);
  if (!lacking.length) return null;
  const list = new Intl.ListFormat(i18n.locale, { type: "conjunction", style: "narrow" }).format(
    lacking.map((c) => {
      const label = c.label;
      const missing = c.missing;
      return t`${missing} more as “${label}”`;
    }),
  );
  return t`Label ${list} before training`;
}

/**
 * untrained：還沒有模型；stale：類別改過，舊模型不能用；outdated：標記和訓練時不一樣（重新訓練會更準）；current：最新
 */
export type TrainStatus = "untrained" | "stale" | "outdated" | "current";

export function trainStatus(s: StateSensorDto): TrainStatus {
  const m = s.model;
  if (!m) return "untrained";
  if (s.problem?.code === "stale-model") return "stale";
  const same = s.images.labeled.every((l) => m.counts.find((c) => c.label === l.label)?.count === l.count);
  return same ? "current" : "outdated";
}

export const jobActive = (s: StateSensorDto) => s.job?.state === "queued" || s.job?.state === "running";

export interface ResultSummary {
  headline: string;
  perClass: { label: string; correct: number; total: number; pct: number }[];
  /** 看錯的組合，例如「移動中」被當成「開」2 張；多的在前 */
  mistakes: { actual: string; predicted: string; count: number }[];
}

export function resultSummary(m: StateModelDto): ResultSummary {
  const v = m.validation;
  const used = m.counts.reduce((n, c) => n + c.count, 0);
  if (!v) return { headline: plural(used, { one: "Trained on # labeled image", other: "Trained on # labeled images" }), perClass: [], mistakes: [] };
  const total = v.perClass.reduce((n, p) => n + p.total, 0);
  const correct = v.perClass.reduce((n, p) => n + p.correct, 0);
  const mistakes: ResultSummary["mistakes"] = [];
  v.confusion.forEach((row, i) =>
    row.forEach((count, j) => {
      if (i !== j && count > 0) mistakes.push({ actual: m.classes[i] ?? "?", predicted: m.classes[j] ?? "?", count });
    }),
  );
  mistakes.sort((a, b) => b.count - a.count);
  return {
    headline:
      correct === total
        ? plural(total, { one: "Checked against your # labeled image: correct", other: "Checked against your # labeled images: all correct" })
        : plural(total, { one: `Checked against your # labeled image: ${correct} correct`, other: `Checked against your # labeled images: ${correct} correct` }),
    perClass: v.perClass.map((p) => ({ ...p, pct: p.total ? Math.round((p.correct / p.total) * 100) : 0 })),
    mistakes,
  };
}

// ─── 類別編輯 ───

/** 編輯中的一列：original 是伺服器上的原名（新加的為 null） */
export interface ClassRow {
  key: string;
  original: string | null;
  name: string;
}

export const rowsOf = (classes: readonly string[]): ClassRow[] => classes.map((c, i) => ({ key: `c${i}:${c}`, original: c, name: c }));

export interface ClassPlan {
  /** 先刪掉的類別（已標記的退回待標記） */
  removed: string[];
  /** 依序呼叫 rename；循環（甲→乙、乙→甲）會先借一個暫時的名字 */
  renames: { from: string; to: string }[];
  /** 最後的類別清單 */
  classes: string[];
}

export function planClassEdit(original: readonly string[], rows: readonly ClassRow[]): ClassPlan {
  const kept = new Set(rows.map((r) => r.original).filter((o): o is string => o !== null));
  const removed = original.filter((c) => !kept.has(c));
  const pending = rows.filter((r) => r.original !== null && r.original !== r.name.trim()).map((r) => ({ from: r.original!, to: r.name.trim() }));
  const current = new Set(original.filter((c) => kept.has(c)));
  const renames: ClassPlan["renames"] = [];
  let temp = 0;
  while (pending.length) {
    const i = pending.findIndex((p) => !current.has(p.to));
    if (i >= 0) {
      const [p] = pending.splice(i, 1);
      current.delete(p!.from);
      current.add(p!.to);
      renames.push(p!);
      continue;
    }
    const p = pending[0]!;
    let t: string;
    do t = `${p.from}-${++temp}`.slice(-MAX_CLASS_NAME);
    while (current.has(t));
    renames.push({ from: p.from, to: t });
    current.delete(p.from);
    current.add(t);
    p.from = t;
  }
  return { removed, renames, classes: rows.map((r) => r.name.trim()) };
}

// ─── 框選區域 ───

export const MIN_CROP = 0.03;
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

export const roundCrop = (c: CropBox): CropBox => [round(c[0]), round(c[1]), round(c[2]), round(c[3])];

/** 兩個角 → 合法的矩形（至少 MIN_CROP 見方，不出畫面） */
export function rectFrom(a: [number, number], b: [number, number]): CropBox {
  let x1 = clamp(Math.min(a[0], b[0]));
  let x2 = clamp(Math.max(a[0], b[0]));
  let y1 = clamp(Math.min(a[1], b[1]));
  let y2 = clamp(Math.max(a[1], b[1]));
  if (x2 - x1 < MIN_CROP) [x1, x2] = x1 + MIN_CROP > 1 ? [1 - MIN_CROP, 1] : [x1, x1 + MIN_CROP];
  if (y2 - y1 < MIN_CROP) [y1, y2] = y1 + MIN_CROP > 1 ? [1 - MIN_CROP, 1] : [y1, y1 + MIN_CROP];
  return [x1, y1, x2, y2];
}

export function moveRect(c: CropBox, dx: number, dy: number): CropBox {
  const w = c[2] - c[0];
  const h = c[3] - c[1];
  const x = clamp(c[0] + dx, 0, 1 - w);
  const y = clamp(c[1] + dy, 0, 1 - h);
  return [x, y, x + w, y + h];
}

/** 拖某個角或邊：handle 是 n、s、e、w 的組合（例如 "ne"）；對面的邊不動 */
export function resizeRect(c: CropBox, handle: string, x: number, y: number): CropBox {
  let [x1, y1, x2, y2] = c;
  if (handle.includes("w")) x1 = clamp(x, 0, x2 - MIN_CROP);
  if (handle.includes("e")) x2 = clamp(x, x1 + MIN_CROP, 1);
  if (handle.includes("n")) y1 = clamp(y, 0, y2 - MIN_CROP);
  if (handle.includes("s")) y2 = clamp(y, y1 + MIN_CROP, 1);
  return [x1, y1, x2, y2];
}

/** 新感應器的預設區域：畫面中央 */
export const DEFAULT_CROP: CropBox = [0.3, 0.25, 0.7, 0.75];

/** 從 Frigate 設定裡挑一個：名稱跟這台攝影機一樣的優先，否則第一個 */
export function pickFrigateSensor(result: FrigateConfigResultDto, cameraName: string): FrigateConfigResultDto["sensors"][number] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  return result.sensors.find((s) => norm(s.camera) === norm(cameraName)) ?? result.sensors[0]!;
}

/** 數字鍵 1 到 9、0 對應第 1 到 10 個類別；不是數字鍵時為 null */
export function classIndexOfKey(key: string, count: number): number | null {
  if (!/^[0-9]$/.test(key)) return null;
  const i = key === "0" ? 9 : Number(key) - 1;
  return i < count ? i : null;
}

/** 門檻與間隔的白話 */
export const THRESHOLD_PRESETS = [
  { value: 0.6, label: msg`Lenient` },
  { value: 0.8, label: msg`Standard` },
  { value: 0.9, label: msg`Strict` },
] as const;
