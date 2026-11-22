import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { StateChangeDto, StateSensorDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { dropItem, putItem } from "../data/cache.ts";

/** 所有狀態感應器；SSE（`status-stream.ts`）的 snapshot 與 state-sensor 一直在更新它 */
export const statesQuery = queryOptions({ queryKey: ["states"], queryFn: api.states, staleTime: Infinity });

/** 一個感應器的圖片；label 是 pending、all 或類別名稱。張數變了時 SSE 會讓它重抓 */
export const stateImagesQuery = (id: string, label: string) =>
  queryOptions({ queryKey: ["states", id, "images", { label }], queryFn: () => api.stateImages(id, label), staleTime: Infinity });

export const HISTORY_LIMIT = 30;

/** 最近的狀態切換；新的一筆由 SSE 的 state-change 加在最前面 */
export const stateChangesQuery = (sensorId: string) =>
  queryOptions({ queryKey: ["state-changes", { sensorId }], queryFn: () => api.stateChanges(sensorId, HISTORY_LIMIT), staleTime: Infinity });

/** 圖片張數或背景工作的結果變了：已經抓過的圖片清單過時了 */
function imagesChanged(prev: StateSensorDto | undefined, next: StateSensorDto): boolean {
  if (!prev) return false;
  if (JSON.stringify(prev.images) !== JSON.stringify(next.images)) return true;
  return prev.config.classes.join("\n") !== next.config.classes.join("\n");
}

/** SSE 的 state-sensor：寫進清單，張數變了就讓圖片清單重抓（標記中的畫面會以伺服器的結果為準） */
export function onSensorMessage(qc: QueryClient, s: StateSensorDto): void {
  const prev = qc.getQueryData(statesQuery.queryKey)?.find((x) => x.id === s.id);
  putItem(qc, statesQuery, s);
  if (imagesChanged(prev, s)) void qc.invalidateQueries({ queryKey: ["states", s.id, "images"] });
  // 類別改名時切換紀錄裡的名稱也跟著改了
  if (prev && prev.config.classes.join("\n") !== s.config.classes.join("\n")) void qc.invalidateQueries({ queryKey: stateChangesQuery(s.id).queryKey });
}

export function onSensorRemoved(qc: QueryClient, id: string): void {
  dropItem(qc, statesQuery, id);
  qc.removeQueries({ queryKey: ["states", id] });
  qc.removeQueries({ queryKey: stateChangesQuery(id).queryKey });
}

export function onStateChange(qc: QueryClient, c: StateChangeDto): void {
  qc.setQueryData(stateChangesQuery(c.sensorId).queryKey, (list) => (list ? [c, ...list.filter((x) => x.id !== c.id)].slice(0, HISTORY_LIMIT) : list));
}
