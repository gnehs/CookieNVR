import type { EventSourceKind } from "../api-types.ts";

/** 事件最長 10 分鐘，超過就切成新事件 */
export const MAX_EVENT_MS = 10 * 60_000;
/** 連續這麼多張畫面有動作才開始 */
export const START_FRAMES = 2;

export type Source = "pixel" | "onvif";

/**
 * 輸入訊號：
 * - pixel：一張畫面的差分結果（score 為 null 代表這張沒計算，例如暖機或鏡頭移動中）
 * - onvif：相機事件的布林狀態改變；kind 是 motion、person 等，`sync` 代表訂閱當下的初始狀態，不算新事件
 * - onvif-lost：訂閱中斷，相機回報的狀態不再可信
 * - tick：每秒一次，負責冷卻與切段
 * - stop：偵測關閉、攝影機刪除或主程序結束，進行中的事件立刻收尾
 */
export type Signal =
  | { type: "pixel"; at: number; score: number | null; motion: boolean }
  | { type: "onvif"; at: number; kind: string; active: boolean; sync: boolean }
  | { type: "onvif-lost"; at: number }
  | { type: "tick"; at: number }
  | { type: "stop"; at: number };

export type Effect =
  | { type: "start"; at: number; source: EventSourceKind; score: number; labels: string[] }
  /** 分數創新高（thumb: true 表示要換縮圖）、來源或標籤改變 */
  | { type: "update"; score: number; source: EventSourceKind; labels: string[]; thumb: boolean }
  | { type: "end"; at: number };

interface Active {
  tag: "active";
  startMs: number;
  lastMotionMs: number;
  peak: number;
  sources: Set<Source>;
  labels: Set<string>;
}

export interface LifecycleState {
  /** 連續有動作的張數與第一張的時間 */
  streak: number;
  streakStart: number;
  /** 相機目前回報為 true 的種類 */
  onvifActive: Set<string>;
  event: Active | null;
}

export const initialState = (): LifecycleState => ({ streak: 0, streakStart: 0, onvifActive: new Set(), event: null });

/** ONVIF 的人形、車輛、寵物記成標籤；單純的動作不記 */
const LABEL_KINDS = new Set(["person", "vehicle", "pet"]);

const sourceOf = (s: Set<Source>): EventSourceKind => (s.size === 2 ? "both" : s.has("onvif") ? "onvif" : "pixel");

function begin(state: LifecycleState, at: number, source: Source, score: number, labels: string[]): Effect {
  state.event = { tag: "active", startMs: at, lastMotionMs: at, peak: score, sources: new Set([source]), labels: new Set(labels) };
  return { type: "start", at, source, score, labels };
}

function updateOf(e: Active, thumb: boolean): Effect {
  return { type: "update", score: e.peak, source: sourceOf(e.sources), labels: [...e.labels].sort(), thumb };
}

/**
 * 一台攝影機的事件狀態機。就地修改 state，回傳要執行的動作；沒有 I/O，時間全部來自訊號。
 */
export function step(state: LifecycleState, signal: Signal, cooldownMs: number): Effect[] {
  const fx: Effect[] = [];
  const e = state.event;
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
          fx.push(begin(state, state.streakStart, "pixel", signal.score, []));
          state.event!.lastMotionMs = signal.at;
        }
        break;
      }
      e.lastMotionMs = signal.at;
      const newSource = !e.sources.has("pixel");
      e.sources.add("pixel");
      const peaked = signal.score > e.peak;
      if (peaked) e.peak = signal.score;
      if (peaked || newSource) fx.push(updateOf(e, peaked));
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
        fx.push(begin(state, signal.at, "onvif", 0, labels));
        break;
      }
      e.lastMotionMs = Math.max(e.lastMotionMs, signal.at);
      const before = e.sources.size + e.labels.size;
      e.sources.add("onvif");
      for (const l of labels) e.labels.add(l);
      if (e.sources.size + e.labels.size !== before) fx.push(updateOf(e, false));
      break;
    }
    case "onvif-lost":
      if (state.onvifActive.size && e) e.lastMotionMs = Math.max(e.lastMotionMs, signal.at);
      state.onvifActive.clear();
      break;
    case "tick": {
      if (!e) break;
      if (state.onvifActive.size) e.lastMotionMs = signal.at;
      if (signal.at - e.startMs >= MAX_EVENT_MS) {
        fx.push({ type: "end", at: signal.at });
        state.event = null;
        // 還在動就接著開新的一筆，來源與標籤延續
        if (signal.at - e.lastMotionMs < cooldownMs) {
          state.event = { ...e, startMs: signal.at, peak: 0 };
          fx.push({ type: "start", at: signal.at, source: sourceOf(e.sources), score: 0, labels: [...e.labels].sort() });
        }
        break;
      }
      if (signal.at - e.lastMotionMs >= cooldownMs) {
        fx.push({ type: "end", at: e.lastMotionMs });
        state.event = null;
      }
      break;
    }
    case "stop":
      state.streak = 0;
      if (e) {
        const last = state.onvifActive.size ? signal.at : Math.min(signal.at, e.lastMotionMs);
        fx.push({ type: "end", at: Math.max(e.startMs, last) });
        state.event = null;
      }
      state.onvifActive.clear();
      break;
  }
  return fx;
}
