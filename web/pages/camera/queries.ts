import { queryOptions } from "@tanstack/react-query";
import type { SegmentDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { browserTz } from "../../format.ts";
import { parseDayKey } from "../../ui/date-logic.ts";

export const sortSegs = (list: SegmentDto[]) => list.slice().sort((a, b) => a.startMs - b.startMs);

/** 有錄影的日子，由舊到新。只在打開頁面、按「回到最新」與播放跨過午夜時更新，換日期不會因為重抓而跳走 */
export const daysQuery = (id: string) => {
  const tz = browserTz();
  return queryOptions({
    queryKey: ["cameras", id, "days", { tz }],
    queryFn: async () => (await api.days(id, tz)).flatMap((d) => parseDayKey(d) ?? []).sort(),
    staleTime: Infinity,
  });
};

export const recordingsQuery = (id: string, start: number, end: number) =>
  queryOptions({ queryKey: ["cameras", id, "recordings", { start, end }], queryFn: async () => sortSegs(await api.recordings(id, start, end)) });

export const dayEventsQuery = (camera: string, start: number, end: number) =>
  queryOptions({
    queryKey: ["events", { camera, start, end }],
    queryFn: async () => (await api.events(camera, start, end)).slice().sort((a, b) => a.startMs - b.startMs),
  });

export const exportsQuery = queryOptions({ queryKey: ["exports"], queryFn: api.exports });

