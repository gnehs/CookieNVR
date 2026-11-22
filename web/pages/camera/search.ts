import { dayOf, parseDayKey, type DayKey } from "../../ui/date-logic.ts";

/**
 * 單台頁 `/cameras/$id` 的網址參數（事件頁的連結也用這組）：
 * date 瀏覽器時區的日子 YYYY-MM-DD；t 從這個時間點（epoch 毫秒）開始播。兩個都沒有就是即時畫面。
 */
export interface CameraSearch {
  date?: DayKey;
  t?: number;
}

/** 頁面只有這一個模式，由網址決定；PTZ、畫質、倍速與顯示哪個 `<video>` 都看它 */
export type View = { kind: "live" } | { kind: "playback"; date: DayKey; t?: number };

export function parseCameraSearch(s: Record<string, unknown>): CameraSearch {
  const out: CameraSearch = {};
  const date = parseDayKey(typeof s.date === "string" ? s.date : null);
  if (date) out.date = date;
  const t = Number(s.t);
  if (s.t !== undefined && s.t !== null && Number.isFinite(t) && t > 0) out.t = Math.round(t);
  return out;
}

export function viewOf(s: CameraSearch): View {
  if (s.date === undefined && s.t === undefined) return { kind: "live" };
  return { kind: "playback", date: s.date ?? dayOf(s.t!), t: s.t };
}

/** 舊網址 `/recordings?camera=&date=&t=` 轉到哪裡；沒有攝影機就回列表 */
export function recordingsRedirect(s: Record<string, unknown>): { camera: string; search: CameraSearch } | null {
  // 純數字的 id 會被當成數字解析回來
  const camera = (typeof s.camera === "string" && s.camera) || typeof s.camera === "number" ? String(s.camera) : null;
  return camera === null ? null : { camera, search: parseCameraSearch(s) };
}
