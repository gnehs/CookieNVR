import { OnvifClient, startPullPointSubscriber, type OnvifEvent, type PullPointSubscriber, type SubscriberStatus } from "../onvif/index.ts";
import { onvifEndpointOf } from "../ptz/config.ts";
import type { Camera, CameraId } from "../types.ts";
import { detectConfigOf, usesOnvif } from "./config.ts";

/** 觸發事件的種類；遮蔽與相機自訂的智慧事件不算動作 */
const TRIGGER_KINDS = new Set(["motion", "person", "vehicle", "pet", "line-crossing"]);

export type OnvifSignal = { kind: string; active: boolean; at: number; sync: boolean } | { lost: true; at: number };

export interface OnvifSourceOptions {
  onSignal(id: CameraId, signal: OnvifSignal): void;
  fetch?: typeof fetch;
  now?: () => number;
}

/** 診斷用：訂閱狀態與最近一次收到的通知 */
export interface OnvifSourceStatus {
  status: SubscriberStatus;
  lastEvent: { kind: string; topic: string; active: boolean | null; at: number } | null;
}

export interface OnvifSources {
  /** 攝影機清單或設定變動後呼叫：需要的建、不需要的停、端點改了的重建 */
  reconcile(cameras: Camera[]): void;
  status(id: CameraId): OnvifSourceStatus | null;
  stop(): Promise<void>;
}

interface Entry {
  key: string;
  subscriber: PullPointSubscriber;
  lastEvent: OnvifSourceStatus["lastEvent"];
}

/** 把 ONVIF 通知轉成生命週期訊號；不是觸發種類、或沒有布林值的回 null */
export function toSignal(e: OnvifEvent): OnvifSignal | null {
  if (e.active === null || !TRIGGER_KINDS.has(e.kind)) return null;
  return { kind: e.kind, active: e.active, at: e.at, sync: e.operation === "initialized" };
}

/** 每台攝影機一個 OnvifClient 加一個長時間運作的 PullPoint 訂閱器，跑在主程序（只是 HTTP 長輪詢） */
export function createOnvifSources(opts: OnvifSourceOptions): OnvifSources {
  const entries = new Map<CameraId, Entry>();
  const now = opts.now ?? Date.now;

  function drop(id: CameraId): void {
    const e = entries.get(id);
    if (!e) return;
    entries.delete(id);
    void e.subscriber.stop();
    opts.onSignal(id, { lost: true, at: now() });
  }

  return {
    reconcile(cameras) {
      const wanted = new Map<CameraId, { key: string; camera: Camera }>();
      for (const camera of cameras) {
        if (!camera.config.enabled || !usesOnvif(detectConfigOf(camera.config))) continue;
        const endpoint = onvifEndpointOf(camera.config.connection);
        if (!endpoint) continue;
        wanted.set(camera.id, { key: JSON.stringify(endpoint), camera });
      }
      for (const id of [...entries.keys()]) if (wanted.get(id)?.key !== entries.get(id)!.key) drop(id);
      for (const [id, { key, camera }] of wanted) {
        if (entries.has(id)) continue;
        const endpoint = onvifEndpointOf(camera.config.connection)!;
        const client = new OnvifClient(endpoint, { fetch: opts.fetch, now });
        const entry: Entry = { key, subscriber: null as unknown as PullPointSubscriber, lastEvent: null };
        entry.subscriber = startPullPointSubscriber({
          client,
          now,
          onEvent(e) {
            if (entries.get(id) !== entry) return;
            entry.lastEvent = { kind: e.kind, topic: e.topic, active: e.active, at: e.at };
            const signal = toSignal(e);
            if (signal) opts.onSignal(id, signal);
          },
          onStatus(s) {
            if (entries.get(id) === entry && s.state === "backoff") opts.onSignal(id, { lost: true, at: now() });
          },
        });
        entries.set(id, entry);
      }
    },
    status(id) {
      const e = entries.get(id);
      return e ? { status: e.subscriber.status(), lastEvent: e.lastEvent } : null;
    },
    async stop() {
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map((e) => e.subscriber.stop()));
    },
  };
}
