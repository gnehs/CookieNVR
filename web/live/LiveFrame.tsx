import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
import type { CameraDto } from "../../src/api-types.ts";
import { Icon } from "../ui/Icon.tsx";
import { hasPoster, loadPoster, usePoster } from "./posters.ts";
import type { LiveTarget } from "./transport.ts";
import { liveSupported, type LiveState } from "./video.ts";

/** 沒有即時影像時快照就是畫面，所以刷新得比較勤 */
const FALLBACK_SNAPSHOT_MS = 3_000;
const IDLE_SNAPSHOT_MS = 10_000;
/** 即時影像通常這麼快就會開始；還沒開始才去抓快照（伺服器要跑一次 ffmpeg） */
const SNAPSHOT_GRACE_MS = 1_500;

export function codecHint(codec: string | null): string {
  const hevc = codec !== null && /^(hvc1|hev1)/.test(codec);
  return hevc ? t`This browser can't play H.265 live video` : t`This browser can't play live video from this camera`;
}

export interface LiveFrameProps {
  cam: CameraDto;
  /**
   * 掛載後交出這格的 `<video>` 與狀態回呼，給 `playGrid`／`playSingle` 用；卸載時交出 null。
   * 要是穩定的函式（useCallback），否則每次重畫都會重新登記。
   */
  onTarget?: (target: LiveTarget | null) => void;
  onState?: (s: LiveState) => void;
  /** 加在 `.cam-frame` 上的 class（單台頁的 `live-stage`） */
  className?: string;
}

/**
 * 一台攝影機的畫面（`.cam-frame`）：能播之後是即時 `<video>`，之前或不能播時是快照，兩者都沒有時是佔位圖示。
 * 這個元件只管畫面；連線由呼叫端用 `live/transport.ts` 開在 effect 裡，cleanup 時關掉。
 */
export function LiveFrame({ cam, onTarget, onState, className }: LiveFrameProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<LiveState>(() => (liveSupported() ? { kind: "connecting" } : { kind: "unsupported", reason: "mse", codec: null }));
  const stateRef = useRef(state);
  stateRef.current = state;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    if (!onTarget || !video.current) return;
    onTarget({
      video: video.current,
      onState: (s) => {
        setState(s);
        onStateRef.current?.(s);
      },
    });
    return () => onTarget(null);
  }, [onTarget]);

  const enabled = cam.config.enabled;
  const unsupported = state.kind === "unsupported";
  const poster = usePoster(cam.id);
  const snapshot = enabled ? poster : null;
  const started = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      timer = setTimeout(() => {
        if (stateRef.current.kind !== "playing" && !document.hidden) void loadPoster(cam.id);
        schedule(stateRef.current.kind === "unsupported" ? FALLBACK_SNAPSHOT_MS : IDLE_SNAPSHOT_MS);
      }, ms);
    };
    // 背景已經預載過一張就先放著，等即時影像一下；還沒有圖、重新啟用或確定不能播就立刻抓
    schedule(hasPoster(cam.id) && !unsupported && !started.current ? SNAPSHOT_GRACE_MS : 0);
    started.current = true;
    return () => clearTimeout(timer);
  }, [cam.id, enabled, unsupported]);

  return (
    <span className={className ? `cam-frame ${className}` : "cam-frame"} data-live={state.kind === "playing" && enabled ? "on" : "off"}>
      <span className="cam-ph" aria-hidden="true" hidden={snapshot !== null}>
        <Icon name="camera" size={22} />
      </span>
      <img alt="" decoding="async" hidden={snapshot === null} src={snapshot ?? undefined} />
      <video ref={video} muted playsInline aria-hidden="true" />
      <span className="cam-note" hidden={state.kind !== "unsupported" || state.reason !== "codec"}>
        {state.kind === "unsupported" ? codecHint(state.codec) : null}
      </span>
    </span>
  );
}
