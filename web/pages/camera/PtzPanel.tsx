import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { KeyHints } from "../../ui/Kbd.tsx";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CameraDto, PtzDto } from "../../../src/api-types.ts";
import { ptzQuery } from "../../data/queries.ts";
import { errMsg } from "../../format.ts";
import { createPtzDriver, planMotion, type Clock, type DriverSnapshot, type PtzDriver, type Vec } from "../../ptz/driver.ts";
import { apiTransport, stopOnUnload } from "../../ptz/transport.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Slider } from "../../ui/Slider.tsx";
import type { IconName } from "../../ui/icons.ts";
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
 * 單台頁旁的鏡頭控制。相機不支援時什麼都不畫；暫時連不上時只放一行可重試的提示。
 * onMode 讓外層依有沒有面板調整版面。
 */
export function PtzPanel({ cam, admin, onMode }: { cam: CameraDto; admin: boolean; onMode: (m: "panel" | "note" | undefined) => void }) {
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
  return caps && usable ? <Panel cam={cam} caps={caps} admin={admin} /> : null;
}

function Panel({ cam, caps, admin }: { cam: CameraDto; caps: Supported; admin: boolean }) {
  const { t, i18n } = useLingui();
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
        <Icon name={ICON[dir]} size={22} />
        {dir.startsWith("zoom") ? (
          <span className="ptz-key-label" aria-hidden="true">
            {i18n._(LABEL[dir])}
          </span>
        ) : null}
      </button>
    );
  };

  const speedId = `ptz-speed-${cam.id}`;
  const pct = `${Math.round(speed * 100)}%`;
  return (
    <section className="ptz" aria-label={t`Camera control`}>
      <div className="ptz-head">
        <h2>{t`Camera control`}</h2>
        <span className="ptz-state" aria-live="polite" role="status" data-tone={statusTone}>
          {statusText}
        </span>
      </div>
      <div className="ptz-ctl" data-zoom={hasZoom ? "on" : "off"}>
        <div className="ptz-pad" role="group" aria-label={t`Camera direction`}>
          {key("up")}
          {key("left")}
          <button type="button" className="ptz-key ptz-stop" aria-label={t`Stop`} title={t`Stop`} onClick={() => driverRef.current?.halt()}>
            <Icon name="stop" size={20} />
          </button>
          {key("right")}
          {key("down")}
        </div>
        {hasZoom ? (
          <div className="ptz-zoom" role="group" aria-label={t`Zoom`}>
            {key("zoomIn")}
            {key("zoomOut")}
          </div>
        ) : null}
      </div>
      <div className="ptz-speed">
        <span id={speedId}>{t`Speed`}</span>
        <Slider min={0.1} max={1} step={0.05} aria-labelledby={speedId} aria-valuetext={pct} value={speed} onChange={setSpeed} />
        <output className="num">{pct}</output>
      </div>
      <p className="ptz-hint ptz-keys">
        {plan.hold ? t`Hold to keep turning, tap to nudge.` : t`Tap to move one step.`}
        <KeyHints className="ptz-kbd" hints={[{ keys: ["↑", "↓", "←", "→"], label: t`Turn camera` }]} />
      </p>
      <PtzPresets cameraId={cam.id} initial={caps.presets} max={caps.maxPresets} admin={admin} speed={() => speedRef.current} beforeGo={() => driverRef.current?.cancel()} say={say} />
    </section>
  );
}
