import type { CameraDto, MetricsDto, SettingsDto, SystemDto } from "../src/api-types.ts";
import { api } from "./api.ts";
import { assessHealth, type Health } from "./health.ts";
import { state } from "./state.ts";
import { onStatus, type LiveStatus } from "./status-stream.ts";

export interface HealthSnapshot {
  sys: SystemDto;
  cams: CameraDto[];
  settings: SettingsDto;
  /** 系統資源；狀態頁開著時每 5 秒更新，其他頁面跟著每分鐘的重抓 */
  metrics: MetricsDto | null;
  health: Health;
  at: number;
}

/** Disk space and settings change slowly and are not pushed, so they are fetched now and then. */
const EXTRAS_MS = 60_000;
const listeners = new Set<(s: HealthSnapshot) => void>();
let latest: HealthSnapshot | null = null;
let live: LiveStatus | null = null;
let extras: { sys: SystemDto; settings: SettingsDto; cams: CameraDto[] } | null = null;
let metrics: MetricsDto | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;
let inflight: Promise<void> | null = null;

function compute(): void {
  if (!extras) return;
  const cams = live?.cams ?? extras.cams;
  const sys = { ...extras.sys, workers: live?.workers ?? extras.sys.workers };
  const minFreeBytes = extras.settings.retention.minFreeBytes;
  latest = {
    sys,
    cams,
    settings: extras.settings,
    metrics,
    at: Date.now(),
    health: assessHealth({ cams, workers: sys.workers, disk: sys.disk, minFreeBytes, resources: metrics?.history }),
  };
  for (const fn of listeners) fn(latest);
}

/** 只有管理員讀得到系統狀態；首頁提醒、導覽提示點與狀態頁共用。失敗時 reject，背景更新自己吞掉 */
export function refreshHealth(): Promise<void> {
  if (state.me?.role !== "admin") return Promise.resolve();
  inflight ??= Promise.all([api.system(), api.cameras(), api.settings(), api.metrics(false).catch(() => metrics)])
    .then(([sys, cams, settings, m]) => {
      extras = { sys, cams, settings };
      metrics = m;
      compute();
    })
    .finally(() => (inflight = null));
  return inflight;
}

/** 攝影機與 worker 狀態跟著 SSE（`status-stream.ts`）即時更新，磁碟與設定每分鐘重抓 */
export function startHealthWatch() {
  if (timer) return;
  refreshHealth().catch(() => {});
  timer = setInterval(() => {
    if (!document.hidden) refreshHealth().catch(() => {});
  }, EXTRAS_MS);
  unsubscribe = onStatus((s) => {
    const reconnected = s.full && live !== null;
    live = s;
    // 重新連上時順便更新磁碟，斷線期間錯過的變化一次補齊
    if (reconnected) refreshHealth().catch(() => {});
    else compute();
  });
}

/** 狀態頁自己每 5 秒抓一次系統資源，交給這裡，資源吃緊的判斷與其他頁面共用同一份 */
export function pushMetrics(m: MetricsDto): void {
  metrics = m;
  compute();
}

export function stopHealthWatch() {
  clearInterval(timer);
  timer = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  latest = null;
  live = null;
  extras = null;
  metrics = null;
}

/** 訂閱後立刻收到最近一次的結果（如果有） */
export function onHealth(fn: (s: HealthSnapshot) => void): () => void {
  listeners.add(fn);
  if (latest) fn(latest);
  return () => listeners.delete(fn);
}
