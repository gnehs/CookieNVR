import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { CameraDto, PtzDto } from "../../../src/api-types.ts";
import { ptzQuery } from "../../data/queries.ts";
import { errMsg } from "../../format.ts";
import { createPtzDriver, planMotion, type Clock, type DriverSnapshot, type PtzDriver, type Vec } from "../../ptz/driver.ts";
import { apiTransport, stopOnUnload } from "../../ptz/transport.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Slider } from "../../ui/Slider.tsx";
import type { IconName } from "../../ui/icons.ts";
import { useMedia } from "../../ui/useMedia.ts";
import { PtzPresets } from "./PtzPresets.tsx";

type Dir = "up" | "down" | "left" | "right" | "zoomIn" | "zoomOut";
const VEC: Record<Dir, Vec> = {
  up: { pan: 0, tilt: 1, zoom: 0 },
  down: { pan: 0, tilt: -1, zoom: 0 },
  left: { pan: -1, tilt: 0, zoom: 0 },
  right: { pan: 1, tilt: 0, zoom: 0 },
  zoomIn: { pan: 0, tilt: 0, zoom: 1 },
  zoomOut: { pan: 0, tilt: 0, zoom: -1 },
};
const LABEL: Record<Dir, MessageDescriptor> = { up: msg`Up`, down: msg`Down`, left: msg`Left`, right: msg`Right`, zoomIn: msg`Zoom in`, zoomOut: msg`Zoom out` };
const ICON: Record<Dir, IconName> = { up: "up", down: "down", left: "left", right: "right", zoomIn: "plus", zoomOut: "minus" };
const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", "+": "zoomIn", "=": "zoomIn", "-": "zoomOut", _: "zoomOut" };
const ACTIVATE = new Set([" ", "Enter"]);

const realClock: Clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

type Supported = Extract<PtzDto, { supported: true }>;

/**
 * 單台頁即時畫面的鏡頭控制：方向與縮放鍵經由 portal 疊在畫面上（overlay），預置點、速度與狀態在畫面正下方這一排。
 * 相機不支援時什麼都不畫；暫時連不上時只在那一排放一行可重試的提示。onMode 讓外層知道方向鍵歸不歸鏡頭。
 */
export function PtzPanel({ cam, admin, onMode, overlay }: { cam: CameraDto; admin: boolean; onMode?: (m: "panel" | "note" | undefined) => void; overlay: HTMLElement | null }) {
  const { t } = useLingui();
  // 每次進頁面都重抓（預置點可能被別處改過）；面板開著時不因為視窗重新聚焦而重抓，免得中途換掉 driver
  const q = useQuery({
    ...ptzQuery(cam.id),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const caps = q.data?.supported ? q.data : null;
  const usable = caps !== null && planMotion(caps, caps.prefs.mode) !== null;
  const mode = q.isError ? "note" : usable ? "panel" : undefined;
  useEffect(() => {
    if (!onMode) return;
    onMode(mode);
    return () => onMode(undefined);
  }, [mode, onMode]);

  if (q.isError) {
    const message = errMsg(q.error);
    return (
      <div className="ptz-note" role="status">
        <Icon name="info" size={18} />
        <div className="ptz-note-text">
          <b>{t`Camera control is unavailable right now`}</b>
          {message ? <small>{message}</small> : null}
        </div>
        <Button small icon="refresh" aria-busy={q.isFetching || undefined} disabled={q.isFetching} onClick={() => void q.refetch()}>
          {t`Retry`}
        </Button>
      </div>
    );
  }
  return caps && usable ? <Panel cam={cam} caps={caps} admin={admin} overlay={overlay} /> : null;
}

const SHOWN_KEY = "cookienvr.ptzShown";

function savedShown(): boolean {
  try {
    return localStorage.getItem(SHOWN_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveShown(on: boolean): void {
  try {
    localStorage.setItem(SHOWN_KEY, on ? "on" : "off");
  } catch {}
}

function Panel({ cam, caps, admin, overlay }: { cam: CameraDto; caps: Supported; admin: boolean; overlay: HTMLElement | null }) {
  const { t, i18n } = useLingui();
  const [shown, setShown] = useState(savedShown);
  // 手機上畫面太矮，右下角放不下縮放鍵，移到畫面下方那一排
  const narrow = useMedia("(max-width: 760px)");
  const [speed, setSpeed] = useState(() => Math.min(1, Math.max(0.1, caps.prefs.speed)));
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const [snap, setSnap] = useState<DriverSnapshot>({ held: [], moving: false, error: null });
  const [note, setNote] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const driverRef = useRef<PtzDriver | null>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // driver 與全域監聽在 effect 建立；清理時一定送出 stop（卸載、切換頁面、StrictMode 重跑都一樣）
  const { continuous, relative } = caps;
  const mode = caps.prefs.mode;
  const hasZoom = caps.zoom;
  const id = cam.id;
  useEffect(() => {
    const plan = planMotion({ continuous, relative }, mode)!;
    const driver = createPtzDriver({
      transport: apiTransport(id, () => speedRef.current),
      clock: realClock,
      plan,
      onChange: (s) => {
        snapRef.current = s;
        setSnap(s);
      },
    });
    driverRef.current = driver;
    const cancelAll = () => driver.cancel();
    const onKeyDown = (e: KeyboardEvent) => {
      const dir = KEY_DIR[e.key];
      if (!dir || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || document.hidden) return;
      if (dir.startsWith("zoom") && !hasZoom) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable], dialog, [role=dialog]") || document.querySelector("dialog[open], [role=dialog]")) return;
      e.preventDefault();
      if (!e.repeat) driver.press(`k:${dir}`, VEC[dir]);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = KEY_DIR[e.key];
      if (dir) driver.release(`k:${dir}`);
    };
    const onVisibility = () => document.hidden && cancelAll();
    const onPageHide = () => {
      const s = driver.snapshot();
      const active = s.held.length > 0 || s.moving;
      cancelAll();
      if (active) stopOnUnload(id);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", cancelAll);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", cancelAll);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAll();
      driverRef.current = null;
    };
  }, [id, continuous, relative, mode, hasZoom]);

  const plan = planMotion(caps, mode)!;
  const pressed = (dir: Dir) => snap.held.includes(`p:${dir}`) || snap.held.includes(`k:${dir}`);
  const statusText = snap.error ?? (note?.tone === "error" ? note.text : null) ?? (snap.moving ? t`Moving` : (note?.text ?? ""));
  const statusTone = snap.error !== null || note?.tone === "error" ? "error" : statusText ? "info" : "";
  const say = (text: string | null, tone: "info" | "error" = "info") => setNote(text ? { text, tone } : null);

  const key = (dir: Dir) => {
    const p = `p:${dir}`;
    const k = `k:${dir}`;
    return (
      <button
        type="button"
        className={`ptz-key ptz-${dir}`}
        aria-label={i18n._(LABEL[dir])}
        title={i18n._(LABEL[dir])}
        data-pressed={pressed(dir) ? "" : undefined}
        onPointerDown={(e) => {
          if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
          e.preventDefault();
          driverRef.current?.press(p, VEC[dir]);
        }}
        onPointerUp={() => driverRef.current?.release(p)}
        onPointerCancel={() => driverRef.current?.cancel(p)}
        onPointerLeave={() => driverRef.current?.cancel(p)}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (!ACTIVATE.has(e.key)) return;
          e.preventDefault();
          if (!e.repeat) driverRef.current?.press(k, VEC[dir]);
        }}
        onKeyUp={(e: ReactKeyboardEvent) => {
          if (!ACTIVATE.has(e.key)) return;
          e.preventDefault();
          driverRef.current?.release(k);
        }}
        onBlur={() => driverRef.current?.cancel(k)}
        // 輔助技術直接觸發的 click 沒有按下與放開，當成點一下
        onClick={(e) => {
          if (e.detail !== 0) return;
          driverRef.current?.press(`a:${dir}`, VEC[dir]);
          driverRef.current?.release(`a:${dir}`);
        }}
      >
        <Icon name={ICON[dir]} size={20} />
      </button>
    );
  };

  const pct = `${Math.round(speed * 100)}%`;
  const zoom = hasZoom ? (
    <div className="ptz-zoom" role="group" aria-label={t`Zoom`}>
      {key("zoomIn")}
      {key("zoomOut")}
    </div>
  ) : null;
  const turn = t`Turn camera`;
  const hint = `${plan.hold ? t`Hold to keep turning, tap to nudge.` : t`Tap to move one step.`} ${turn} ↑ ↓ ← →`;
  const toggle = () => {
    driverRef.current?.cancel();
    setShown(!shown);
    saveShown(!shown);
  };
  // 畫面中間留空：方向鍵貼著四邊，縮放鍵與開關在右下角
  const onVideo = (
    <>
      {shown ? (
        <div className="ptz-dirs" role="group" aria-label={t`Camera direction`}>
          {key("up")}
          {key("left")}
          {key("right")}
          {key("down")}
        </div>
      ) : null}
      <div className="ptz-corner">
        {shown && !narrow ? zoom : null}
        <button type="button" className="ptz-toggle" aria-pressed={shown} title={shown ? hint : undefined} onClick={toggle}>
          <Icon name="camera" size={16} />
          <span>{t({ message: "Camera", context: "button that shows or hides the pan-tilt-zoom controls" })}</span>
        </button>
      </div>
    </>
  );
  return (
    <>
      {overlay ? createPortal(onVideo, overlay) : null}
      {shown ? (
        <section className="ptz" aria-label={t`Camera control`}>
          <PtzPresets cameraId={cam.id} initial={caps.presets} max={caps.maxPresets} admin={admin} speed={() => speedRef.current} beforeGo={() => driverRef.current?.cancel()} say={say} />
          <div className="ptz-tools">
            {narrow ? zoom : null}
            <button type="button" className="ptz-key ptz-stop" aria-label={t`Stop`} title={t`Stop`} onClick={() => driverRef.current?.halt()}>
              <Icon name="stop" size={18} />
            </button>
            <div className="ptz-speed">
              <Slider min={0.1} max={1} step={0.05} aria-label={t`Speed`} aria-valuetext={pct} value={speed} onChange={setSpeed} />
              <output className="num">{pct}</output>
            </div>
            <span className="ptz-state" aria-live="polite" role="status" data-tone={statusTone}>
              {statusText}
            </span>
          </div>
        </section>
      ) : null}
    </>
  );
}
