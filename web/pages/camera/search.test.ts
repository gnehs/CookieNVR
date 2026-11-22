import { describe, expect, test } from "bun:test";
import { dayOf } from "../../ui/date-logic.ts";
import { parseCameraSearch, recordingsRedirect, viewOf } from "./search.ts";

describe("單台頁的網址", () => {
  test("沒有日期也沒有時間就是即時", () => {
    expect(viewOf(parseCameraSearch({}))).toEqual({ kind: "live" });
    expect(viewOf(parseCameraSearch({ date: "not-a-day", t: "abc" }))).toEqual({ kind: "live" });
  });

  test("有日期或時間就是回放；只有時間時日期取那個時間所在的一天", () => {
    expect(viewOf(parseCameraSearch({ date: "2026-11-18" }))).toEqual({ kind: "playback", date: "2026-11-18", t: undefined });
    const t = new Date(2026, 10, 18, 9, 30).getTime();
    expect(viewOf(parseCameraSearch({ t: String(t + 0.4) }))).toEqual({ kind: "playback", date: dayOf(t), t });
  });

  test("舊的回放網址帶著攝影機、日期與時間轉過來", () => {
    expect(recordingsRedirect({ camera: 12, date: "2026-11-18", t: 1000 })).toEqual({ camera: "12", search: { date: "2026-11-18", t: 1000 } });
    expect(recordingsRedirect({ date: "2026-11-18" })).toBeNull();
    expect(recordingsRedirect({ camera: "" })).toBeNull();
  });
});
