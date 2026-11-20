import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api.ts";

/**
 * 每台攝影機最近一張快照，整個分頁共用。畫面在前景時不管在哪一頁都先替每台抓好一張，
 * 進到攝影機頁就直接有圖可放，即時影像接上之前不會是空的。
 * 存成已解碼好的 object URL：換上 <img> 時不用再等網路或解碼。
 */
const posters = new Map<string, string>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

/** 背景預載的間隔；看得到即時影像的頁面自己會刷得更勤 */
const PRELOAD_MS = 30_000;

function publish(id: string, url: string) {
  const old = posters.get(id);
  posters.set(id, url);
  for (const l of listeners) l();
  // 等 React 把 <img> 換成新圖再回收舊的
  if (old) setTimeout(() => URL.revokeObjectURL(old), 5_000);
}

/** 抓一張新快照；同一台已經在抓就共用那一次。失敗時保留上一張，總比空白好 */
export function loadPoster(id: string): Promise<void> {
  const running = inflight.get(id);
  if (running) return running;
  const job = (async () => {
    try {
      const res = await fetch(api.snapshotUrl(id, Date.now()), { credentials: "same-origin" });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        URL.revokeObjectURL(url);
        return;
      }
      publish(id, url);
    } catch {
      // 網路斷了就留著舊的，下一輪再試
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, job);
  return job;
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function usePoster(id: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => posters.get(id) ?? null,
  );
}

export const hasPoster = (id: string) => posters.has(id);

/** 分頁在前景時替這些攝影機定期抓快照；切回前景立刻補一輪 */
export function usePosterPreload(ids: string[]) {
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      for (const id of list) void loadPoster(id);
      timer = setTimeout(tick, PRELOAD_MS);
    };
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [key]);
}
