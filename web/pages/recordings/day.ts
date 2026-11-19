import { addDays, dayOf, type DayKey } from "../../ui/date-logic.ts";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** 一天在瀏覽器時區的起訖（毫秒），夏令時間那天不是 24 小時 */
export function dayRange(date: DayKey): [number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

export const todayKey = () => dayOf(Date.now());

export function dayLabel(date: DayKey, short = false): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const today = todayKey();
  const rel = date === today ? "今天" : date === addDays(today, -1) ? "昨天" : "";
  // 手機上的日期選單很窄，今天、昨天只寫一個詞
  if (short && rel) return rel;
  return `${m}/${d} 週${WEEKDAY[new Date(y, m - 1, d).getDay()]}${rel ? `（${rel}）` : ""}`;
}
