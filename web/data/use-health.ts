import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { assessHealth, type Health } from "../health.ts";
import { statesQuery } from "../states/queries.ts";
import { camerasQuery, metricsQuery, settingsQuery, systemQuery, workersQuery } from "./queries.ts";

/** 磁碟、設定與系統資源不推送，每分鐘重抓（分頁在背景時暫停）；攝影機與 worker 跟著 SSE */
const EXTRAS_MS = 60_000;

/**
 * 管理員看到的系統健康狀態：首頁提醒、導覽提示點與狀態頁共用同一份判斷。
 * 一般使用者讀不到系統狀態，傳 false 時不發任何請求、回傳 null。
 */
export function useHealth(admin: boolean): Health | null {
  const extras = { enabled: admin, refetchInterval: EXTRAS_MS } as const;
  const sys = useQuery({ ...systemQuery, ...extras }).data;
  const settings = useQuery({ ...settingsQuery, ...extras }).data;
  const metrics = useQuery({ ...metricsQuery(), ...extras }).data;
  const cams = useQuery({ ...camerasQuery, enabled: admin }).data;
  const workers = useQuery({ ...workersQuery, enabled: admin }).data;
  const stateSensors = useQuery({ ...statesQuery, enabled: admin }).data;
  return useMemo(() => {
    if (!sys || !settings || !cams) return null;
    return assessHealth({
      cams,
      workers: workers ?? sys.workers,
      disk: sys.disk,
      dataDisk: sys.dataDisk,
      minFreeBytes: settings.retention.minFreeBytes,
      resources: metrics?.history,
      decodeWarning: sys.decode?.warning ?? null,
      stateSensors,
    });
  }, [sys, settings, metrics, cams, workers, stateSensors]);
}
