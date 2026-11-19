import type { CameraDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { h, icon } from "../dom.ts";
import type { LiveTarget } from "./transport.ts";
import { liveSupported, type LiveState } from "./video.ts";

/** Without live video the snapshot is the picture, so it refreshes this often. */
const FALLBACK_SNAPSHOT_MS = 3_000;
const IDLE_SNAPSHOT_MS = 10_000;
/** Live video usually starts within this; only fetch a snapshot (an ffmpeg run on the server) if it has not. */
const SNAPSHOT_GRACE_MS = 1_500;

export interface LiveFrame {
  /** `.cam-frame`: placeholder, snapshot and video stacked; the caller adds its own overlays */
  el: HTMLElement;
  target: LiveTarget;
  update(cam: CameraDto): void;
  destroy(): void;
}

export function codecHint(codec: string | null): string {
  const hevc = codec !== null && /^(hvc1|hev1)/.test(codec);
  return hevc ? "這個瀏覽器無法播放 H.265 即時畫面" : "這個瀏覽器無法播放這台的即時畫面";
}

/**
 * One camera picture: a live <video> once it plays, a snapshot before that or instead of it,
 * and a placeholder when there is neither.
 */
export function liveFrame(initial: CameraDto, onState?: (s: LiveState) => void): LiveFrame {
  let cam = initial;
  let state: LiveState = liveSupported() ? { kind: "connecting" } : { kind: "unsupported", reason: "mse", codec: null };
  const placeholder = h("span", { class: "cam-ph", "aria-hidden": "true" }, icon("camera", 22));
  const img = h("img", { alt: "", decoding: "async", hidden: true });
  const video = h("video", { muted: true, playsinline: true, "aria-hidden": "true" });
  const note = h("span", { class: "cam-note", hidden: true });
  const el = h("span", { class: "cam-frame" }, placeholder, img, video, note);
  el.dataset.live = "off";

  let loadToken = 0;
  const showPlaceholder = () => {
    img.hidden = true;
    placeholder.hidden = false;
  };
  // 先在背景載好再換上，避免每次刷新都閃回佔位
  const refreshSnapshot = () => {
    if (!cam.config.enabled) return showPlaceholder();
    const token = ++loadToken;
    const probe = new Image();
    probe.onload = () => {
      if (token !== loadToken) return;
      img.src = probe.src;
      img.hidden = false;
      placeholder.hidden = true;
    };
    probe.onerror = () => token === loadToken && showPlaceholder();
    probe.src = api.snapshotUrl(cam.id, Date.now());
  };

  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSnapshot = (ms: number) => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      if (state.kind !== "playing" && !document.hidden) refreshSnapshot();
      scheduleSnapshot(state.kind === "unsupported" ? FALLBACK_SNAPSHOT_MS : IDLE_SNAPSHOT_MS);
    }, ms);
  };

  const paint = () => {
    const playing = state.kind === "playing" && cam.config.enabled;
    el.dataset.live = playing ? "on" : "off";
    note.hidden = state.kind !== "unsupported" || state.reason !== "codec";
    if (state.kind === "unsupported") note.textContent = codecHint(state.codec);
  };

  const target: LiveTarget = {
    video,
    onState(s) {
      const was = state.kind;
      state = s;
      paint();
      if (s.kind === "unsupported" && was !== "unsupported") scheduleSnapshot(0);
      onState?.(s);
    },
  };

  if (!cam.config.enabled) showPlaceholder();
  scheduleSnapshot(state.kind === "unsupported" ? 0 : SNAPSHOT_GRACE_MS);
  paint();

  return {
    el,
    target,
    update(next) {
      const wasEnabled = cam.config.enabled;
      cam = next;
      if (wasEnabled !== cam.config.enabled) refreshSnapshot();
      paint();
    },
    destroy() {
      clearTimeout(snapTimer);
      loadToken++;
    },
  };
}
