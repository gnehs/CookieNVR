import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import type { EventDto } from "../api-types.ts";
import type { CameraId, Unsubscribe } from "../types.ts";
import { initialState, MAX_EVENT_MS, step, wantsObjects, type LifecycleState, type Signal } from "./lifecycle.ts";
import { activeEvents, closeDangling, deleteEventRow, getEvent, insertEvent, updateEvent } from "./store.ts";
import { thumbPath } from "./paths.ts";

/**
 * 給行程內其他模組（HA 整合、HKSV、物件辨識）訂閱的事件通知：
 * - start：事件建立（縮圖可能要再等一秒才有，之後會有 update）
 * - update：分數創新高、換了縮圖、來源或標籤改變
 * - end：事件結束，endMs 已寫入
 */
export interface EventNotice {
  phase: "start" | "update" | "end";
  event: EventDto;
}

export interface EventFeed {
  /** listener 丟出的錯誤會被吞掉，不影響其他訂閱者與偵測 */
  subscribe(listener: (notice: EventNotice) => void): Unsubscribe;
  /** 目前進行中的事件 */
  active(): EventDto[];
}

export interface EventTracker extends EventFeed {
  /** frame：objects 訊號所屬的那張 JPEG，狀態機要拿它當縮圖時寫入 */
  signal(cameraId: CameraId, signal: Signal, cooldownMs: number, frame?: Uint8Array): void;
  /** 這台在等辨識（過濾模式）或有進行中的事件；只有這段時間需要送畫面去辨識 */
  wantsObjects(cameraId: CameraId): boolean;
  /** 每張新的快照都交給它；有等縮圖的事件就寫入 */
  offerJpeg(cameraId: CameraId, jpeg: Uint8Array): void;
  /** 這台目前進行中的事件 */
  activeFor(cameraId: CameraId): EventDto | null;
  /** 刪除已結束的事件與縮圖；進行中的不能刪 */
  remove(id: number): Promise<"deleted" | "active" | "missing">;
  /** 所有攝影機的進行中事件立刻收尾（主程序結束時） */
  stopAll(at: number): void;
}

interface Track {
  state: LifecycleState;
  eventId: number | null;
  /** 下一張快照要寫成這筆事件的縮圖 */
  wantThumb: number | null;
}

export interface TrackerDeps {
  db: Database;
  dataDir: string;
  now?: () => number;
  onError?: (e: unknown) => void;
  /** 這台現在要不要先等辨識才建立事件、最多等多久（過濾模式且 detector 可用）；null 或沒給就是不等 */
  filterWindow?: (cameraId: CameraId) => number | null;
}

export function createEventTracker(deps: TrackerDeps): EventTracker {
  const { db, dataDir } = deps;
  const now = deps.now ?? Date.now;
  const tracks = new Map<CameraId, Track>();
  const listeners = new Set<(n: EventNotice) => void>();
  mkdirSync(`${dataDir}/thumbs`, { recursive: true });

  // 上次沒正常結束（當機、斷電）留下的進行中事件
  closeDangling(db, now(), MAX_EVENT_MS);

  function emit(phase: EventNotice["phase"], event: EventDto | null): void {
    if (!event) return;
    for (const fn of [...listeners]) {
      try {
        fn({ phase, event });
      } catch (e) {
        deps.onError?.(e);
      }
    }
  }

  function track(id: CameraId): Track {
    let t = tracks.get(id);
    if (!t) tracks.set(id, (t = { state: initialState(), eventId: null, wantThumb: null }));
    return t;
  }

  function setThumb(t: Track, id: number, change: "none" | "next" | "frame", frame: Uint8Array | undefined): void {
    if (change === "frame" && frame) {
      if (t.wantThumb === id) t.wantThumb = null;
      writeThumb(id, frame).catch((e) => deps.onError?.(e));
    } else if (change !== "none") t.wantThumb = id;
  }

  function signal(cameraId: CameraId, sig: Signal, cooldownMs: number, frame?: Uint8Array): void {
    const t = track(cameraId);
    const policy = { cooldownMs, filterWindowMs: deps.filterWindow?.(cameraId) ?? null };
    // A failed write (database disk full) drops this signal's effects; callers are timers and stream readers that must keep running.
    try {
      for (const fx of step(t.state, sig, policy)) {
        if (fx.type === "start") {
          const event = insertEvent(db, { cameraId, source: fx.source, startMs: fx.at, score: fx.score, labels: fx.labels });
          t.eventId = event.id;
          emit("start", event);
          setThumb(t, event.id, fx.thumb, frame);
        } else if (fx.type === "update" && t.eventId !== null) {
          emit("update", updateEvent(db, t.eventId, { score: fx.score, source: fx.source, labels: fx.labels }));
          setThumb(t, t.eventId, fx.thumb, frame);
        } else if (fx.type === "end" && t.eventId !== null) {
          const id = t.eventId;
          t.eventId = null;
          if (t.wantThumb === id) t.wantThumb = null;
          emit("end", updateEvent(db, id, { endMs: fx.at }));
        }
      }
    } catch (e) {
      deps.onError?.(e);
    }
    if (sig.type === "stop" && t.state.event === null) tracks.delete(cameraId);
  }

  let thumbSeq = 0;
  async function writeThumb(id: number, jpeg: Uint8Array): Promise<void> {
    const path = thumbPath(dataDir, id);
    // 辨識換縮圖可能和快照縮圖同時寫，暫存檔不能共用
    const tmp = `${path}.${++thumbSeq}.tmp`;
    await Bun.write(tmp, jpeg);
    await rename(tmp, path);
    // 寫入期間事件可能已被刪除
    if (!getEvent(db, id)) return void (await rm(path, { force: true }));
    const event = updateEvent(db, id, { hasThumb: true });
    emit("update", event);
  }

  return {
    signal,
    offerJpeg(cameraId, jpeg) {
      const t = tracks.get(cameraId);
      if (!t || t.wantThumb === null) return;
      const id = t.wantThumb;
      t.wantThumb = null;
      writeThumb(id, jpeg).catch((e) => deps.onError?.(e));
    },
    wantsObjects(cameraId) {
      const t = tracks.get(cameraId);
      return t !== undefined && wantsObjects(t.state);
    },
    activeFor(cameraId) {
      const id = tracks.get(cameraId)?.eventId;
      return id == null ? null : getEvent(db, id);
    },
    async remove(id) {
      const event = getEvent(db, id);
      if (!event) return "missing";
      if (event.endMs === null) return "active";
      deleteEventRow(db, id);
      await rm(thumbPath(dataDir, id), { force: true });
      return "deleted";
    },
    stopAll(at) {
      for (const id of [...tracks.keys()]) signal(id, { type: "stop", at }, 0);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    active: () => activeEvents(db),
  };
}
