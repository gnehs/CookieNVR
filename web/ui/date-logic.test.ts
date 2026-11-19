import { describe, expect, test } from "bun:test";
import { addDays, addMonths, clampDay, dayOf, monthGrid, moveInGrid, parseDayKey, shortDay, spokenDay, stepDay, weekEnd, weekStart, type DayKey } from "./date-logic.ts";

const k = (s: string) => s as DayKey;

describe("加減天數與月份", () => {
  test("跨月、跨年", () => {
    expect(addDays(k("2026-01-31"), 1)).toBe(k("2026-02-01"));
    expect(addDays(k("2026-12-31"), 1)).toBe(k("2027-01-01"));
    expect(addDays(k("2027-01-01"), -1)).toBe(k("2026-12-31"));
    expect(addDays(k("2026-03-01"), -7)).toBe(k("2026-02-22"));
  });

  test("閏年的 2 月 29 日", () => {
    expect(addDays(k("2028-02-28"), 1)).toBe(k("2028-02-29"));
    expect(addDays(k("2026-02-28"), 1)).toBe(k("2026-03-01"));
    expect(addDays(k("2100-02-28"), 1)).toBe(k("2100-03-01"));
    expect(addDays(k("2000-02-28"), 1)).toBe(k("2000-02-29"));
  });

  test("換月時超出的日子停在月底", () => {
    expect(addMonths(k("2026-01-31"), 1)).toBe(k("2026-02-28"));
    expect(addMonths(k("2028-01-31"), 1)).toBe(k("2028-02-29"));
    expect(addMonths(k("2026-03-31"), -1)).toBe(k("2026-02-28"));
    expect(addMonths(k("2026-12-15"), 1)).toBe(k("2027-01-15"));
    expect(addMonths(k("2026-01-15"), -1)).toBe(k("2025-12-15"));
    expect(addMonths(k("2028-02-29"), 12)).toBe(k("2029-02-28"));
  });
});

describe("解析外部輸入", () => {
  test("只接受真的存在的日子", () => {
    expect(parseDayKey("2026-11-19")).toBe(k("2026-11-19"));
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
    expect(parseDayKey("2028-02-29")).toBe(k("2028-02-29"));
    expect(parseDayKey("2026-2-1")).toBeNull();
    expect(parseDayKey(null)).toBeNull();
  });
});

describe("週與月曆格子", () => {
  test("週日開始、週六結束", () => {
    expect(weekStart(k("2026-11-19"))).toBe(k("2026-11-15"));
    expect(weekEnd(k("2026-11-19"))).toBe(k("2026-11-21"));
    expect(weekStart(k("2026-11-15"))).toBe(k("2026-11-15"));
    expect(weekStart(k("2027-01-01"))).toBe(k("2026-12-27"));
  });

  test("固定 42 格，從當月 1 日那週的週日開始", () => {
    const g = monthGrid(2026, 11);
    expect(g).toHaveLength(42);
    expect(g[0]!.key).toBe(k("2026-11-01"));
    expect(g.filter((c) => c.inMonth)).toHaveLength(30);
    const feb = monthGrid(2028, 2);
    expect(feb[0]!.key).toBe(k("2028-01-30"));
    expect(feb.filter((c) => c.inMonth).at(-1)!.key).toBe(k("2028-02-29"));
  });
});

describe("日曆上的按鍵", () => {
  const at = k("2026-11-30");
  test("方向鍵一天與一週，Home／End 到週首與週末", () => {
    expect(moveInGrid(at, "ArrowRight", false)).toBe(k("2026-12-01"));
    expect(moveInGrid(at, "ArrowLeft", false)).toBe(k("2026-11-29"));
    expect(moveInGrid(at, "ArrowDown", false)).toBe(k("2026-12-07"));
    expect(moveInGrid(at, "ArrowUp", false)).toBe(k("2026-11-23"));
    expect(moveInGrid(at, "Home", false)).toBe(k("2026-11-29"));
    expect(moveInGrid(at, "End", false)).toBe(k("2026-12-05"));
  });
  test("PageUp／PageDown 換月，加 Shift 換年", () => {
    expect(moveInGrid(k("2026-03-31"), "PageUp", false)).toBe(k("2026-02-28"));
    expect(moveInGrid(at, "PageDown", false)).toBe(k("2026-12-30"));
    expect(moveInGrid(k("2028-02-29"), "PageDown", true)).toBe(k("2029-02-28"));
  });
});

describe("前一天、後一天", () => {
  const days = new Set([k("2026-10-30"), k("2026-11-02"), k("2026-11-03")]);
  const has = (d: DayKey) => days.has(d);
  test("跳過沒有資料的日子，跨月也一樣", () => {
    expect(stepDay(k("2026-11-02"), -1, has, null, null, 30)).toBe(k("2026-10-30"));
    expect(stepDay(k("2026-10-30"), 1, has, null, null, 30)).toBe(k("2026-11-02"));
  });
  test("超出最早或最晚的日期就沒有下一個", () => {
    expect(stepDay(k("2026-11-03"), 1, has, null, k("2026-11-19"))).toBeNull();
    expect(stepDay(k("2026-10-30"), -1, has, k("2026-10-01"), null)).toBeNull();
    expect(stepDay(k("2026-11-19"), 1, () => true, null, k("2026-11-19"))).toBeNull();
  });
  test("clamp", () => {
    expect(clampDay(k("2026-12-01"), null, k("2026-11-19"))).toBe(k("2026-11-19"));
    expect(clampDay(k("2026-01-01"), k("2026-02-01"), null)).toBe(k("2026-02-01"));
  });
});

describe("顯示", () => {
  test("今天、昨天，其他是月/日加週幾；不同年份才寫年", () => {
    const today = k("2026-01-02");
    expect(shortDay(today, today)).toBe("今天");
    expect(shortDay(k("2026-01-01"), today)).toBe("昨天");
    expect(shortDay(k("2025-12-31"), today)).toBe("2025/12/31 週三");
    expect(shortDay(k("2026-01-01"), k("2026-01-05"))).toBe("1/1 週四");
    expect(spokenDay(k("2026-11-19"))).toBe("2026 年 11 月 19 日 星期四");
  });
});

describe("瀏覽器時區", () => {
  /** 在指定時區執行，結束後換回來；Bun 會在 TZ 改變時重新讀取時區 */
  function inTz<T>(tz: string, f: () => T): T {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      return f();
    } finally {
      process.env.TZ = prev;
    }
  }

  test("同一個時間點在不同時區是不同的一天", () => {
    const ms = Date.UTC(2026, 10, 18, 16, 30);
    expect(inTz("Asia/Taipei", () => dayOf(ms))).toBe(k("2026-11-19"));
    expect(inTz("UTC", () => dayOf(ms))).toBe(k("2026-11-18"));
  });

  test("當地午夜前後一毫秒分屬兩天", () => {
    inTz("Asia/Taipei", () => {
      const midnight = new Date(2027, 0, 1).getTime();
      expect(dayOf(midnight - 1)).toBe(k("2026-12-31"));
      expect(dayOf(midnight)).toBe(k("2027-01-01"));
    });
  });

  test("日光節約切換的那天，加一天仍然是隔天", () => {
    inTz("America/New_York", () => {
      expect(addDays(k("2026-03-08"), 1)).toBe(k("2026-03-09"));
      expect(addDays(k("2026-11-01"), 1)).toBe(k("2026-11-02"));
      const springForward = new Date(2026, 2, 8, 23, 30).getTime();
      expect(dayOf(springForward)).toBe(k("2026-03-08"));
    });
  });
});
