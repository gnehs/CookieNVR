/**
 * 日曆用的純日期計算：以「YYYY-MM-DD」字串代表瀏覽器時區的一天。
 * 加減天數與月份一律用 UTC 的年月日運算，不經過當地時間，日光節約的那天也不會多一天或少一天。
 */
export type DayKey = `${number}-${number}-${number}`;

/** 週日開始：跟台灣常見的月曆、手機內建日曆一致，也跟全站的「週日…週六」寫法同一個順序 */
export const WEEK_START = 0;
export const WEEKDAY_SHORT = ["日", "一", "二", "三", "四", "五", "六"] as const;
export const WEEKDAY_LONG = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

function ymd(k: DayKey): [number, number, number] {
  const [y, m, d] = k.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

function fromUtc(ms: number): DayKey {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` as DayKey;
}

const utc = (k: DayKey) => {
  const [y, m, d] = ymd(k);
  return Date.UTC(y, m - 1, d);
};

/** 外部輸入（網址參數、API）的日期字串；不是真的日子（例如 2 月 30 日）就回傳 null */
export function parseDayKey(s: string | null | undefined): DayKey | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const k = s as DayKey;
  return fromUtc(utc(k)) === k ? k : null;
}

/** 某個時間點在瀏覽器時區是哪一天 */
export function dayOf(ms: number): DayKey {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` as DayKey;
}

export function makeDay(year: number, month: number, day: number): DayKey {
  return fromUtc(Date.UTC(year, month - 1, day));
}

export function addDays(k: DayKey, n: number): DayKey {
  return fromUtc(utc(k) + n * 86_400_000);
}

/** 換月時日子超出新月份的天數就停在月底（1/31 加一個月是 2/28 或 2/29） */
export function addMonths(k: DayKey, n: number): DayKey {
  const [y, m, d] = ymd(k);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return makeDay(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d, last));
}

export const weekday = (k: DayKey) => new Date(utc(k)).getUTCDay();
export const weekStart = (k: DayKey) => addDays(k, -((weekday(k) - WEEK_START + 7) % 7));
export const weekEnd = (k: DayKey) => addDays(weekStart(k), 6);
export const compareDay = (a: DayKey, b: DayKey) => (a < b ? -1 : a > b ? 1 : 0);
export const monthOf = (k: DayKey) => k.slice(0, 7);

export function clampDay(k: DayKey, min: DayKey | null, max: DayKey | null): DayKey {
  if (min && k < min) return min;
  if (max && k > max) return max;
  return k;
}

export interface MonthCell {
  key: DayKey;
  day: number;
  inMonth: boolean;
}

/** 固定六週 42 格：換月時面板高度不跳動 */
export function monthGrid(year: number, month: number): MonthCell[] {
  const first = makeDay(year, month, 1);
  const start = weekStart(first);
  const ym = monthOf(first);
  return Array.from({ length: 42 }, (_, i) => {
    const key = addDays(start, i);
    return { key, day: ymd(key)[2], inMonth: monthOf(key) === ym };
  });
}

export const monthTitle = (year: number, month: number) => `${year} 年 ${month} 月`;
export const yearMonth = (k: DayKey): [number, number] => {
  const [y, m] = ymd(k);
  return [y, m];
};

/** 螢幕閱讀器念的完整日期：「2026 年 11 月 19 日 星期四」 */
export function spokenDay(k: DayKey): string {
  const [y, m, d] = ymd(k);
  return `${y} 年 ${m} 月 ${d} 日 ${WEEKDAY_LONG[weekday(k)]}`;
}

/** 按鈕上的短日期：「今天」「昨天」，其他是「11/17 週二」；不同年份才寫年 */
export function shortDay(k: DayKey, today: DayKey): string {
  if (k === today) return "今天";
  if (k === addDays(today, -1)) return "昨天";
  const [y, m, d] = ymd(k);
  return `${y === ymd(today)[0] ? "" : `${y}/`}${m}/${d} 週${WEEKDAY_SHORT[weekday(k)]}`;
}

export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";

/** 日曆格子上的方向鍵：左右一天、上下一週、Home／End 到週首週末、PageUp／PageDown 換月（加 Shift 換年） */
export function moveInGrid(k: DayKey, key: GridKey, shift: boolean): DayKey {
  switch (key) {
    case "ArrowLeft":
      return addDays(k, -1);
    case "ArrowRight":
      return addDays(k, 1);
    case "ArrowUp":
      return addDays(k, -7);
    case "ArrowDown":
      return addDays(k, 7);
    case "Home":
      return weekStart(k);
    case "End":
      return weekEnd(k);
    case "PageUp":
      return addMonths(k, shift ? -12 : -1);
    case "PageDown":
      return addMonths(k, shift ? 12 : 1);
  }
}

/** 往前或往後找下一個可選的日子（回放頁的前一天、後一天會跳過沒有錄影的日子） */
export function stepDay(k: DayKey, dir: 1 | -1, selectable: (k: DayKey) => boolean, min: DayKey | null, max: DayKey | null, limit = 3660): DayKey | null {
  let cur = k;
  for (let i = 0; i < limit; i++) {
    cur = addDays(cur, dir);
    if ((min && cur < min) || (max && cur > max)) return null;
    if (selectable(cur)) return cur;
  }
  return null;
}
