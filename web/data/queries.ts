import { queryOptions } from "@tanstack/react-query";
import type { EventDto } from "../../src/api-types.ts";
import type { WorkerStatus } from "../../src/types.ts";
import { api } from "../api.ts";

// 全站共用的查詢。key 的規則：API 路徑的各段，參數放最後一個物件，例如 GET /api/cameras/:id/days?tz= 是
// ["cameras", id, "days", { tz }]。這樣各頁自己定義的 key 不會撞到別人的，invalidate ["cameras"] 也會連帶更新底下的子資源。

/** SSE（`status-stream.ts`）一直在更新這份清單；第一次打開頁面時也會自己抓一次 */
export const camerasQuery = queryOptions({ queryKey: ["cameras"], queryFn: api.cameras });
/** 分區由 SSE 的 camera-groups 推送更新 */
export const cameraGroupsQuery = queryOptions({ queryKey: ["camera-groups"], queryFn: api.cameraGroups });

export const settingsQuery = queryOptions({ queryKey: ["settings"], queryFn: api.settings });

/** 只有管理員讀得到；worker 狀態另外由 SSE 推送（`workersQuery`） */
export const systemQuery = queryOptions({ queryKey: ["system"], queryFn: api.system });

/** 系統資源；狀態頁開著時改用 `metricsQuery(true)` 每 5 秒抓，並把結果也寫進這個 key（健康判斷共用） */
export const metricsQuery = (watch = false) =>
  queryOptions({ queryKey: watch ? ["system", "metrics", { watch: true }] : ["system", "metrics"], queryFn: () => api.metrics(watch) });

/** 只有管理員有；SSE 推送，沒連上時從 /api/system 取 */
export const workersQuery = queryOptions({
  queryKey: ["stream", "workers"],
  queryFn: async (): Promise<WorkerStatus[] | null> => (await api.system()).workers,
  staleTime: Infinity,
});

/** PTZ 能力與偏好；單台頁的面板與攝影機設定表單共用 */
export const ptzQuery = (id: string) => queryOptions({ queryKey: ["cameras", id, "ptz"], queryFn: () => api.ptz(id) });

const OBJECTS_POLL_MS = 3_000;
/** 測速中進度條要跟得上 */
const OBJECTS_POLL_BENCH_MS = 1_000;

/** 物件辨識的狀態、模型與測速；watch 時每幾秒更新，測速中每秒一次（分頁在背景時自動暫停） */
export const objectsQuery = (watch: boolean) =>
  queryOptions({
    queryKey: ["objects"],
    queryFn: api.objects,
    refetchInterval: (q) => {
      if (!watch) return false;
      const d = q.state.data;
      return d?.benchmark?.state === "running" || d?.status.paused === "benchmark" ? OBJECTS_POLL_BENCH_MS : OBJECTS_POLL_MS;
    },
  });

/** 物件類別的目錄，執行期間不會變 */
export const objectLabelsQuery = queryOptions({ queryKey: ["objects", "labels"], queryFn: api.objectLabels, staleTime: Infinity });

/** 事件最長 10 分鐘，往前抓 11 分鐘就不會漏掉還在進行的 */
export const ACTIVE_WINDOW_MS = 11 * 60_000;

/** 所有攝影機進行中的事件；SSE 推送 */
export const activeEventsQuery = queryOptions({
  queryKey: ["events", "active"],
  queryFn: (): Promise<EventDto[]> => {
    const t = Date.now();
    return api.activeEvents(t - ACTIVE_WINDOW_MS, t);
  },
  staleTime: Infinity,
});
