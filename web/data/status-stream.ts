import type { QueryClient } from "@tanstack/react-query";
import type { CameraDto, EventDto, StateChangeDto, StateSensorDto, StreamSnapshotDto } from "../../src/api-types.ts";
import type { WorkerStatus } from "../../src/types.ts";
import { onSensorMessage, onSensorRemoved, onStateChange, statesQuery } from "../states/queries.ts";
import { activeEventsQuery, camerasQuery, systemQuery, workersQuery } from "./queries.ts";

const POLL_MS = 5_000;
/** 連續這麼多次連線都沒收到完整狀態，就先改成輪詢 */
const FAILURES_BEFORE_POLLING = 3;

function upsert<T extends { id: string | number }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

const parse = <T,>(e: Event): T => JSON.parse((e as MessageEvent<string>).data) as T;

/**
 * 全站唯一一條 `GET /api/stream`：攝影機、worker、進行中的事件與狀態感應器推進 Query 快取
 * （`camerasQuery`、`workersQuery`、`activeEventsQuery`、`statesQuery`），頁面照常 useQuery 就會跟著更新。
 * SSE 一直連不上時改成每 5 秒輪詢同樣三份資料。回傳的函式關掉連線並停止一切計時器。
 */
export function startStatusStream(qc: QueryClient, opts: { admin: boolean }): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  let snapshots = 0;
  let running = true;

  const setCams = (fn: (cams: CameraDto[]) => CameraDto[]) => qc.setQueryData(camerasQuery.queryKey, (cams) => (cams ? fn(cams) : cams));
  const setEvents = (fn: (events: EventDto[]) => EventDto[]) => qc.setQueryData(activeEventsQuery.queryKey, (list) => fn(list ?? []));

  function connect(): void {
    const es = new EventSource("/api/stream");
    source = es;
    es.addEventListener("snapshot", (e) => {
      failures = 0;
      stopPolling();
      const s = parse<StreamSnapshotDto>(e);
      qc.setQueryData(camerasQuery.queryKey, s.cameras);
      qc.setQueryData(workersQuery.queryKey, s.workers);
      qc.setQueryData(activeEventsQuery.queryKey, s.events);
      qc.setQueryData(statesQuery.queryKey, s.stateSensors);
      // 重新連上：磁碟與設定這些不推送的資料、狀態切換紀錄與圖片清單，斷線期間錯過的變化一次補齊
      if (snapshots++ > 0) {
        if (opts.admin) void qc.invalidateQueries({ queryKey: systemQuery.queryKey });
        void qc.invalidateQueries({ queryKey: ["state-changes"] });
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "states" && q.queryKey.length > 1 });
      }
    });
    es.addEventListener("cameras", (e) => qc.setQueryData(camerasQuery.queryKey, parse<CameraDto[]>(e)));
    es.addEventListener("camera", (e) => setCams((cams) => upsert(cams, parse<CameraDto>(e))));
    es.addEventListener("worker", (e) => {
      const w = parse<WorkerStatus>(e);
      qc.setQueryData(workersQuery.queryKey, (list) => list && (w.state === "stopped" ? list.filter((x) => x.id !== w.id) : upsert(list, w)));
    });
    es.addEventListener("event", (e) => {
      const { phase, event } = parse<{ phase: "start" | "update" | "end"; event: EventDto }>(e);
      // update：進行中的事件類別變了（物件辨識確認了新的東西），換成最新的那筆
      setEvents((list) => (phase === "end" ? list.filter((x) => x.id !== event.id) : upsert(list, event)));
    });
    es.addEventListener("state-sensor", (e) => onSensorMessage(qc, parse<StateSensorDto>(e)));
    es.addEventListener("state-sensor-removed", (e) => onSensorRemoved(qc, parse<{ id: string }>(e).id));
    es.addEventListener("state-change", (e) => onStateChange(qc, parse<StateChangeDto>(e)));
    es.onerror = () => {
      // CONNECTING：瀏覽器已經在重試，重連後伺服器會先送完整狀態
      if (es.readyState !== EventSource.CLOSED) return;
      source = null;
      failures++;
      if (failures >= FAILURES_BEFORE_POLLING) startPolling();
      retryTimer = setTimeout(() => running && connect(), Math.min(1000 * 2 ** failures, 30_000));
    };
  }

  const pollOnce = () => {
    if (document.hidden) return;
    void qc.fetchQuery({ ...camerasQuery, staleTime: 0 }).catch(() => {});
    void qc.fetchQuery({ ...activeEventsQuery, staleTime: 0 }).catch(() => {});
    void qc.fetchQuery({ ...statesQuery, staleTime: 0 }).catch(() => {});
    if (opts.admin) void qc.fetchQuery({ ...workersQuery, staleTime: 0 }).catch(() => {});
  };

  function startPolling(): void {
    if (pollTimer !== undefined || !running) return;
    pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }

  function stopPolling(): void {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  // 離開頁面時關掉連線（進了瀏覽器的返回快取也不會一直佔著連線名額），回來時重連；重連會先收到完整狀態
  const onHide = () => {
    source?.close();
    source = null;
    clearTimeout(retryTimer);
  };
  const onShow = (e: PageTransitionEvent) => {
    if (e.persisted && running && !source && pollTimer === undefined) connect();
  };
  addEventListener("pagehide", onHide);
  addEventListener("pageshow", onShow);

  if (typeof EventSource === "undefined") startPolling();
  else connect();

  return () => {
    running = false;
    removeEventListener("pagehide", onHide);
    removeEventListener("pageshow", onShow);
    source?.close();
    source = null;
    clearTimeout(retryTimer);
    stopPolling();
  };
}
