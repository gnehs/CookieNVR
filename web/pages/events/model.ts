import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import type { EventDto } from "../../../src/api-types.ts";
import { EVENT_PREROLL_MS } from "../../timeline/model.ts";
import { addDays, type DayKey, dayOf } from "../../ui/date-logic.ts";

/** 「今天」「昨天」，其他是日期加星期（「11/17 週二」）；不同年份才寫年 */
export function dayTitle(key: string, now: number): string {
  if (key === dayOf(now)) return t`Today`;
  if (key === addDays(dayOf(now), -1)) return t`Yesterday`;
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const sameYear = y === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(i18n.locale, { ...(sameYear ? {} : { year: "numeric" }), month: "numeric", day: "numeric", weekday: "short" }).format(new Date(y, m - 1, d));
}

/** 依開始時間由新到舊、去掉重複；同一筆以後來的為準（例如進行中變成已結束） */
export function mergeEvents(list: readonly EventDto[], incoming: readonly EventDto[]): EventDto[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.startMs - a.startMs || b.id - a.id);
}

/** 已排好序（由新到舊）的事件依瀏覽器時區分天 */
export function groupByDay(events: readonly EventDto[]): { key: string; events: EventDto[] }[] {
  const out: { key: string; events: EventDto[] }[] = [];
  for (const e of events) {
    const key = dayOf(e.startMs);
    const last = out[out.length - 1];
    if (last?.key === key) last.events.push(e);
    else out.push({ key, events: [e] });
  }
  return out;
}

/** 單台頁（`/cameras/$id`）回放的 search：從事件開始前 5 秒播起 */
export function playbackSearch(e: Pick<EventDto, "startMs">): { date: DayKey; t: number } {
  return { date: dayOf(e.startMs), t: e.startMs - EVENT_PREROLL_MS };
}
