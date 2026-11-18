import type { CameraDto, SettingsDto, SystemDto } from "../src/api-types.ts";
import { api } from "./api.ts";
import { assessHealth, type Health } from "./health.ts";
import { state } from "./state.ts";

export interface HealthSnapshot {
  sys: SystemDto;
  cams: CameraDto[];
  settings: SettingsDto;
  health: Health;
  at: number;
}

const POLL_MS = 5000;
const listeners = new Set<(s: HealthSnapshot) => void>();
let latest: HealthSnapshot | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let inflight: Promise<void> | null = null;

/** 只有管理員讀得到系統狀態；首頁提醒、導覽提示點與狀態頁共用這一個輪詢。失敗時 reject，背景輪詢自己吞掉 */
export function refreshHealth(): Promise<void> {
  if (state.me?.role !== "admin") return Promise.resolve();
  inflight ??= Promise.all([api.system(), api.cameras(), api.settings()])
    .then(([sys, cams, settings]) => {
      latest = { sys, cams, settings, at: Date.now(), health: assessHealth({ cams, workers: sys.workers, disk: sys.disk, minFreeBytes: settings.retention.minFreeBytes }) };
      for (const fn of listeners) fn(latest);
    })
    .finally(() => (inflight = null));
  return inflight;
}

export function startHealthWatch() {
  if (timer) return;
  refreshHealth().catch(() => {});
  timer = setInterval(() => {
    if (!document.hidden) refreshHealth().catch(() => {});
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
}

export function stopHealthWatch() {
  clearInterval(timer);
  timer = undefined;
  latest = null;
  document.removeEventListener("visibilitychange", onVisible);
}

function onVisible() {
  if (!document.hidden) refreshHealth().catch(() => {});
}

/** 訂閱後立刻收到最近一次的結果（如果有） */
export function onHealth(fn: (s: HealthSnapshot) => void): () => void {
  listeners.add(fn);
  if (latest) fn(latest);
  return () => listeners.delete(fn);
}
