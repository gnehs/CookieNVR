import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef } from "react";
import type { CameraDto } from "../../../src/api-types.ts";
import { playSingle, type LiveTarget, type Quality } from "../../live/transport.ts";

const QUALITY_KEY = "cookienvr.liveQuality";

export function savedQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === "hd" ? "hd" : "sd";
  } catch {
    return "sd";
  }
}

export function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {}
}

/**
 * 單台的即時連線：`onTarget` 交給 LiveFrame，`on` 為 false（回放中）時連線關掉。
 * `video()` 是 LiveFrame 目前的 `<video>`，換到回放前拿來留最後一格畫面。
 */
export function useLiveVideo(cam: CameraDto, quality: Quality, on: boolean) {
  const target = useRef<LiveTarget | null>(null);
  const onTarget = useCallback((next: LiveTarget | null) => {
    target.current = next;
  }, []);
  const id = cam.id;
  const enabled = cam.config.enabled;
  // 子元件的 effect 先跑，這裡拿得到 <video>；啟用狀態、畫質或模式變了才重開
  useEffect(() => {
    if (!on || !enabled || !target.current) return;
    return playSingle(id, quality, target.current);
  }, [id, enabled, quality, on]);
  return { onTarget, video: () => target.current?.video ?? null };
}

/** 整個畫面格（連同疊在上面的按鈕）進全螢幕；iPhone 沒有 Fullscreen API，只能讓影片本身全螢幕 */
export function toggleFullscreen(stage: HTMLElement | null, video: HTMLVideoElement | null) {
  const v = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
  if (!stage) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (stage.requestFullscreen) void stage.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
  else v?.webkitEnterFullscreen?.();
}

/** 畫面左上角的「即時」 */
export function LiveChip() {
  const { t } = useLingui();
  return <span className="pb-chip live">{t`Live`}</span>;
}

/** 控制列上的「即時」：不能按，回放時同一個位置換成「回到即時」 */
export function LivePill() {
  const { t } = useLingui();
  return <span className="pb-pill">{t`Live`}</span>;
}
