import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { addDays, dayOf, type DayKey } from "../../ui/date-logic.ts";

/** 一天在瀏覽器時區的起訖（毫秒），夏令時間那天不是 24 小時 */
export function dayRange(date: DayKey): [number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

export const todayKey = () => dayOf(Date.now());

/** `withRel` 為 false 時不加「今天」「昨天」的註記 */
export function dayLabel(date: DayKey, short = false, withRel = true): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const today = todayKey();
  const rel = date === today ? t`Today` : date === addDays(today, -1) ? t`Yesterday` : "";
  // 手機上的日期選單很窄，今天、昨天只寫一個詞
  if (short && rel) return rel;
  const base = new Intl.DateTimeFormat(i18n.locale, { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(y, m - 1, d));
  return rel && withRel ? t`${base} (${rel})` : base;
}
