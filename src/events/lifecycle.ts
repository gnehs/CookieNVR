import type { EventSourceKind } from "../api-types.ts";

/** 事件最長 10 分鐘，超過就切成新事件 */
export const MAX_EVENT_MS = 10 * 60_000;
/** 連續這麼多張畫面有動作才開始 */
export const START_FRAMES = 2;
/** 同一類別連續這麼多張辨識結果超過門檻，才算確認 */
export const OBJECT_FRAMES = 2;
/** 過濾模式：動作觸發後預設最多等辨識這麼久，沒有關注的類別就丟棄（辨識頻率很低時呼叫端會給更長的期限） */
export const FILTER_WINDOW_MS = 3_000;

export type Source = "pixel" | "onvif";

/** 一張辨識結果中，已套用門檻、遮罩與關注類別之後留下的物件 */
export interface ObjectHit {
  label: string;
  score: number;
}

/**
 * 輸入訊號：
 * - pixel：一張畫面的差分結果（score 為 null 代表這張沒計算，例如暖機或鏡頭移動中）
 * - onvif：相機事件的布林狀態改變；kind 是 motion、person 等，`sync` 代表訂閱當下的初始狀態，不算新事件
 * - onvif-lost：訂閱中斷，相機回報的狀態不再可信
 * - objects：一張畫面的物件辨識結果（hits 可為空，代表這張沒有關注的物件）
 * - tick：每 0.5 秒一次，負責冷卻、切段與過濾模式的等待期限
 * - stop：偵測關閉、攝影機刪除或主程序結束，進行中的事件立刻收尾
 */
export type Signal =
  | { type: "pixel"; at: number; score: number | null; motion: boolean }
  | { type: "onvif"; at: number; kind: string; active: boolean; sync: boolean }
  | { type: "onvif-lost"; at: number }
  | { type: "objects"; at: number; hits: readonly ObjectHit[] }
  | { type: "tick"; at: number }
  | { type: "stop"; at: number };

/** 縮圖要怎麼換：next = 下一張快照；frame = 這個 objects 訊號所屬的那張畫面 */
export type ThumbChange = "none" | "next" | "frame";

export type Effect =
  | { type: "start"; at: number; source: EventSourceKind; score: number; labels: string[]; thumb: "next" | "frame" }
  /** 分數創新高、辨識到更有把握的物件（換縮圖）、來源或標籤改變 */
  | { type: "update"; score: number; source: EventSourceKind; labels: string[]; thumb: ThumbChange }
  | { type: "end"; at: number };

interface Motion {
  startMs: number;
  lastMotionMs: number;
  peak: number;
  sources: Set<Source>;
  labels: Set<string>;
}

/** 已建立、對外通知過的事件 */
interface Active extends Motion {
  tag: "active";
  /** 縮圖那張畫面上最有把握的物件信心值；0 = 縮圖還是動作快照 */
  objectPeak: number;
}

/** 過濾模式：有動作但還在等辨識，沒有寫進資料庫也沒有通知 */
interface Pending extends Motion {
  tag: "pending";
}

export interface LifecycleState {
  /** 連續有動作的張數與第一張的時間 */
  streak: number;
  streakStart: number;
  /** 相機目前回報為 true 的種類 */
  onvifActive: Set<string>;
  /** 每個類別連續出現在辨識結果的張數 */
  objectStreak: Map<string, number>;
  event: Active | Pending | null;
}

/**
 * 每次呼叫 step 時由呼叫端給的設定。filterWindowMs 是「現在要不要等辨識、最多等多久」：攝影機設為過濾模式、
 * 且 detector 可用時才有值；detector 掛掉時變回 null，等待中的動作立刻建立事件。
 */
export interface Policy {
  cooldownMs: number;
  filterWindowMs: number | null;
}

export const initialState = (): LifecycleState => ({ streak: 0, streakStart: 0, onvifActive: new Set(), objectStreak: new Map(), event: null });

/** ONVIF 的人形、車輛、寵物記成標籤；單純的動作不記 */
const LABEL_KINDS = new Set(["person", "vehicle", "pet"]);

const sourceOf = (s: Set<Source>): EventSourceKind => (s.size === 2 ? "both" : s.has("onvif") ? "onvif" : "pixel");
const sorted = (labels: Set<string>) => [...labels].sort();

function begin(state: LifecycleState, at: number, source: Source, score: number, labels: string[], policy: Policy): Effect[] {
  const motion: Motion = { startMs: at, lastMotionMs: at, peak: score, sources: new Set([source]), labels: new Set(labels) };
  if (policy.filterWindowMs !== null) {
    state.event = { tag: "pending", ...motion };
    return [];
  }
  state.event = { tag: "active", ...motion, objectPeak: 0 };
  return [{ type: "start", at, source, score, labels: sorted(motion.labels), thumb: "next" }];
}

/** 等待中的動作轉成正式事件；開始時間仍是第一張有動作的畫面 */
function promote(state: LifecycleState, p: Pending, objectPeak: number): Effect {
  const e: Active = { ...p, tag: "active", objectPeak };
  state.event = e;
  return { type: "start", at: e.startMs, source: sourceOf(e.sources), score: e.peak, labels: sorted(e.labels), thumb: objectPeak > 0 ? "frame" : "next" };
}

function updateOf(e: Active, thumb: ThumbChange): Effect {
  return { type: "update", score: e.peak, source: sourceOf(e.sources), labels: sorted(e.labels), thumb };
}

function clearObjects(state: LifecycleState): void {
  state.objectStreak.clear();
}

/**
 * 一台攝影機的事件狀態機。就地修改 state，回傳要執行的動作；沒有 I/O，時間全部來自訊號。
 */
export function step(state: LifecycleState, signal: Signal, policy: Policy): Effect[] {
  const fx: Effect[] = [];
  const e = state.event;
  const { cooldownMs } = policy;
  switch (signal.type) {
    case "pixel": {
      if (!signal.motion || signal.score === null) {
        state.streak = 0;
        break;
      }
      if (state.streak === 0) state.streakStart = signal.at;
      state.streak++;
      if (!e) {
        if (state.streak >= START_FRAMES) {
          fx.push(...begin(state, state.streakStart, "pixel", signal.score, [], policy));
          state.event!.lastMotionMs = signal.at;
        }
        break;
      }
      e.lastMotionMs = signal.at;
      const newSource = !e.sources.has("pixel");
      e.sources.add("pixel");
      const peaked = signal.score > e.peak;
      if (peaked) e.peak = signal.score;
      // 已經有物件畫面當縮圖時，動作分數再高也不換
      if (e.tag === "active" && (peaked || newSource)) fx.push(updateOf(e, peaked && e.objectPeak === 0 ? "next" : "none"));
      break;
    }
    case "onvif": {
      if (!signal.active) {
        if (state.onvifActive.delete(signal.kind) && e) e.lastMotionMs = Math.max(e.lastMotionMs, signal.at);
        break;
      }
      // 訂閱當下就已經是 true：不是新的觸發，也不記為進行中，免得一個沒收到 false 的狀態讓事件永遠不結束
      if (signal.sync) break;
      state.onvifActive.add(signal.kind);
      const labels = LABEL_KINDS.has(signal.kind) ? [signal.kind] : [];
      if (!e) {
        fx.push(...begin(state, signal.at, "onvif", 0, labels, policy));
        break;
      }
      e.lastMotionMs = Math.max(e.lastMotionMs, signal.at);
      const before = e.sources.size + e.labels.size;
      e.sources.add("onvif");
      for (const l of labels) e.labels.add(l);
      if (e.tag === "active" && e.sources.size + e.labels.size !== before) fx.push(updateOf(e, "none"));
      break;
    }
    case "onvif-lost":
      if (state.onvifActive.size && e) e.lastMotionMs = Math.max(e.lastMotionMs, signal.at);
      state.onvifActive.clear();
      break;
    case "objects": {
      const seen = new Set(signal.hits.map((h) => h.label));
      for (const label of [...state.objectStreak.keys()]) if (!seen.has(label)) state.objectStreak.delete(label);
      for (const label of seen) state.objectStreak.set(label, (state.objectStreak.get(label) ?? 0) + 1);
      const confirmed = signal.hits.filter((h) => (state.objectStreak.get(h.label) ?? 0) >= OBJECT_FRAMES);
      if (!e || confirmed.length === 0) break;
      const best = Math.max(...confirmed.map((h) => h.score));
      const before = e.labels.size;
      for (const h of confirmed) e.labels.add(h.label);
      if (e.tag === "pending") {
        fx.push(promote(state, e, best));
        break;
      }
      const better = best > e.objectPeak;
      if (better) e.objectPeak = best;
      if (better || e.labels.size !== before) fx.push(updateOf(e, better ? "frame" : "none"));
      break;
    }
    case "tick": {
      if (!e) break;
      if (state.onvifActive.size) e.lastMotionMs = signal.at;
      if (e.tag === "pending") {
        // detector 不能用了（或改回標註模式）：寧可多報也不漏報
        if (policy.filterWindowMs === null) fx.push(promote(state, e, 0));
        else if (signal.at - e.startMs >= policy.filterWindowMs) {
          // 持續的動作要重新累積連續張數，下一輪等待才有完整的 3 秒
          state.event = null;
          state.streak = 0;
          clearObjects(state);
        }
        break;
      }
      if (signal.at - e.startMs >= MAX_EVENT_MS) {
        fx.push({ type: "end", at: signal.at });
        state.event = null;
        // 還在動就接著開新的一筆，來源與標籤延續
        if (signal.at - e.lastMotionMs < cooldownMs) {
          state.event = { ...e, startMs: signal.at, peak: 0, objectPeak: 0 };
          fx.push({ type: "start", at: signal.at, source: sourceOf(e.sources), score: 0, labels: sorted(e.labels), thumb: "next" });
        } else clearObjects(state);
        break;
      }
      if (signal.at - e.lastMotionMs >= cooldownMs) {
        fx.push({ type: "end", at: e.lastMotionMs });
        state.event = null;
        clearObjects(state);
      }
      break;
    }
    case "stop":
      state.streak = 0;
      if (e?.tag === "active") {
        const last = state.onvifActive.size ? signal.at : Math.min(signal.at, e.lastMotionMs);
        fx.push({ type: "end", at: Math.max(e.startMs, last) });
      }
      state.event = null;
      state.onvifActive.clear();
      clearObjects(state);
      break;
  }
  return fx;
}

/** 這台現在是否在等或正在記錄事件；只有這段時間需要把畫面送去辨識 */
export const wantsObjects = (state: LifecycleState) => state.event !== null;
