import type { CameraDto, StreamSnapshotDto } from "../src/api-types.ts";
import type { WorkerStatus } from "../src/types.ts";
import { api } from "./api.ts";
import { state } from "./state.ts";

/** Cameras with their online and recording state, plus worker status for admins. */
export interface LiveStatus {
  cams: CameraDto[];
  /** null for non-admins */
  workers: WorkerStatus[] | null;
  /** a full state just arrived (first connect or reconnect), as opposed to an incremental update */
  full: boolean;
}

const POLL_MS = 5_000;
/** Give up on SSE for now after this many connections in a row that never delivered a snapshot. */
const FAILURES_BEFORE_POLLING = 3;

const listeners = new Set<(s: LiveStatus) => void>();
let latest: LiveStatus | null = null;
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let failures = 0;
let running = false;

function emit(next: LiveStatus): void {
  latest = next;
  for (const fn of listeners) fn(next);
}

function update(patch: (s: LiveStatus) => Partial<LiveStatus>): void {
  if (latest) emit({ ...latest, ...patch(latest), full: false });
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
}

const parse = <T>(e: Event): T => JSON.parse((e as MessageEvent<string>).data) as T;

function connect(): void {
  const es = new EventSource("/api/stream");
  source = es;
  es.addEventListener("snapshot", (e) => {
    failures = 0;
    stopPolling();
    const s = parse<StreamSnapshotDto>(e);
    emit({ cams: s.cameras, workers: s.workers, full: true });
  });
  es.addEventListener("cameras", (e) => update(() => ({ cams: parse<CameraDto[]>(e) })));
  es.addEventListener("camera", (e) => update((s) => ({ cams: upsert(s.cams, parse<CameraDto>(e)) })));
  es.addEventListener("worker", (e) => {
    const w = parse<WorkerStatus>(e);
    update((s) => ({ workers: s.workers && (w.state === "stopped" ? s.workers.filter((x) => x.id !== w.id) : upsert(s.workers, w)) }));
  });
  es.onerror = () => {
    // CONNECTING means the browser is already retrying; on reconnect the server sends a fresh snapshot.
    if (es.readyState !== EventSource.CLOSED) return;
    source = null;
    failures++;
    if (failures >= FAILURES_BEFORE_POLLING) startPolling();
    retryTimer = setTimeout(() => running && connect(), Math.min(1000 * 2 ** failures, 30_000));
  };
}

async function pollOnce(): Promise<void> {
  if (document.hidden) return;
  const admin = state.me?.role === "admin";
  const [cams, sys] = await Promise.all([api.cameras(), admin ? api.system() : null]);
  if (pollTimer !== undefined) emit({ cams, workers: sys?.workers ?? null, full: false });
}

function startPolling(): void {
  if (pollTimer !== undefined || !running) return;
  pollTimer = setInterval(() => void pollOnce().catch(() => {}), POLL_MS);
  void pollOnce().catch(() => {});
}

function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

/** Starts pushing status over `GET /api/stream`, falling back to polling when SSE does not work. */
export function startStatusStream(): void {
  if (running) return;
  running = true;
  failures = 0;
  if (typeof EventSource === "undefined") startPolling();
  else connect();
}

export function stopStatusStream(): void {
  running = false;
  source?.close();
  source = null;
  clearTimeout(retryTimer);
  stopPolling();
  latest = null;
}

/** Subscribes; gets the latest status at once when there is one. */
export function onStatus(fn: (s: LiveStatus) => void): () => void {
  listeners.add(fn);
  if (latest) fn(latest);
  return () => listeners.delete(fn);
}
