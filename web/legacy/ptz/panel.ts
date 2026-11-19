import type { CameraDto, PtzDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { h, icon } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { createPtzDriver, planMotion, type Clock, type DriverSnapshot, type Vec } from "./driver.ts";
import { presetSection } from "./presets.ts";
import { apiTransport, stopOnUnload } from "./transport.ts";

type Dir = "up" | "down" | "left" | "right" | "zoomIn" | "zoomOut";
const VEC: Record<Dir, Vec> = {
  up: { pan: 0, tilt: 1, zoom: 0 },
  down: { pan: 0, tilt: -1, zoom: 0 },
  left: { pan: -1, tilt: 0, zoom: 0 },
  right: { pan: 1, tilt: 0, zoom: 0 },
  zoomIn: { pan: 0, tilt: 0, zoom: 1 },
  zoomOut: { pan: 0, tilt: 0, zoom: -1 },
};
const LABEL: Record<Dir, string> = { up: "向上", down: "向下", left: "向左", right: "向右", zoomIn: "放大", zoomOut: "縮小" };
const ICON: Record<Dir, string> = { up: "up", down: "down", left: "left", right: "right", zoomIn: "plus", zoomOut: "minus" };
const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", "+": "zoomIn", "=": "zoomIn", "-": "zoomOut", _: "zoomOut" };
const ACTIVATE = new Set([" ", "Enter"]);

const realClock: Clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/**
 * 在單台頁面旁掛上鏡頭控制。相機不支援時什麼都不留（host 保持原樣）；
 * 暫時連不上時只在畫面下方放一行可重試的提示。
 */
export function mountPtz(host: HTMLElement, ctx: PageCtx, cam: CameraDto, admin: boolean): void {
  if (!cam.config.enabled) return;
  let teardown = () => {};
  ctx.onCleanup(() => teardown());

  const show = (mode: "panel" | "note", el: HTMLElement, destroy = () => {}) => {
    teardown();
    teardown = () => {
      destroy();
      el.remove();
      delete host.dataset.ptz;
    };
    host.dataset.ptz = mode;
    host.append(el);
  };

  const load = async () => {
    try {
      const dto = await api.ptz(cam.id);
      if (!ctx.isCurrent()) return;
      const panel = dto.supported ? buildPanel(cam, dto, admin) : null;
      if (panel) show("panel", panel.el, panel.destroy);
      else teardown();
    } catch (e) {
      if (!ctx.isCurrent()) return;
      show("note", unavailableNote(e instanceof Error ? e.message : "", async (btn) => {
        btn.setAttribute("aria-busy", "true");
        btn.disabled = true;
        await load();
      }));
    }
  };
  void load();
}

function unavailableNote(message: string, retry: (btn: HTMLButtonElement) => Promise<void>): HTMLElement {
  const btn = h("button", { class: "btn small", type: "button" }, icon("refresh", 16), "重試");
  btn.addEventListener("click", () => void retry(btn));
  return h(
    "div",
    { class: "ptz-note", role: "status" },
    icon("info", 18),
    h("div", { class: "ptz-note-text" }, h("b", null, "暫時無法控制鏡頭"), message ? h("small", null, message) : null),
    btn,
  );
}

type Supported = Extract<PtzDto, { supported: true }>;

function buildPanel(cam: CameraDto, caps: Supported, admin: boolean): { el: HTMLElement; destroy: () => void } | null {
  const plan = planMotion(caps, caps.prefs.mode);
  if (!plan) return null;

  let speed = Math.min(1, Math.max(0.1, caps.prefs.speed));
  let note: { text: string; tone: "info" | "error" } | null = null;
  let snap: DriverSnapshot = { held: [], moving: false, error: null };

  const status = h("span", { class: "ptz-state", "aria-live": "polite", role: "status" });
  const paintStatus = () => {
    const text = snap.error ?? (note?.tone === "error" ? note.text : null) ?? (snap.moving ? "移動中" : (note?.text ?? ""));
    const isError = snap.error !== null || note?.tone === "error";
    status.textContent = text;
    status.dataset.tone = isError ? "error" : text ? "info" : "";
  };

  const keys = new Map<Dir, HTMLButtonElement>();
  const paintKeys = () => {
    for (const [dir, btn] of keys) {
      const pressed = snap.held.includes(`p:${dir}`) || snap.held.includes(`k:${dir}`);
      if (pressed) btn.dataset.pressed = "";
      else delete btn.dataset.pressed;
    }
  };

  const driver = createPtzDriver({
    transport: apiTransport(cam.id, () => speed),
    clock: realClock,
    plan,
    onChange: (s) => {
      snap = s;
      paintKeys();
      paintStatus();
    },
  });

  const makeKey = (dir: Dir) => {
    const btn = h("button", { type: "button", class: `ptz-key ptz-${dir}`, "aria-label": LABEL[dir], title: LABEL[dir] }, icon(ICON[dir], 22), dir.startsWith("zoom") ? h("span", { class: "ptz-key-label", "aria-hidden": "true" }, LABEL[dir]) : null);
    keys.set(dir, btn);
    const p = `p:${dir}`;
    const k = `k:${dir}`;
    btn.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      driver.press(p, VEC[dir]);
    });
    btn.addEventListener("pointerup", () => driver.release(p));
    btn.addEventListener("pointercancel", () => driver.cancel(p));
    btn.addEventListener("pointerleave", () => driver.cancel(p));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.addEventListener("keydown", (e) => {
      if (!ACTIVATE.has(e.key)) return;
      e.preventDefault();
      if (!e.repeat) driver.press(k, VEC[dir]);
    });
    btn.addEventListener("keyup", (e) => {
      if (!ACTIVATE.has(e.key)) return;
      e.preventDefault();
      driver.release(k);
    });
    btn.addEventListener("blur", () => driver.cancel(k));
    // 輔助技術直接觸發的 click 沒有按下與放開，當成點一下
    btn.addEventListener("click", (e) => {
      if (e.detail !== 0) return;
      driver.press(`a:${dir}`, VEC[dir]);
      driver.release(`a:${dir}`);
    });
    return btn;
  };

  const stopBtn = h("button", { type: "button", class: "ptz-key ptz-stop", "aria-label": "停止", title: "停止", onclick: () => driver.halt() }, icon("stop", 20));
  const pad = h(
    "div",
    { class: "ptz-pad", role: "group", "aria-label": "鏡頭方向" },
    makeKey("up"),
    makeKey("left"),
    stopBtn,
    makeKey("right"),
    makeKey("down"),
  );
  const zoom = caps.zoom
    ? h("div", { class: "ptz-zoom", role: "group", "aria-label": "變焦" }, makeKey("zoomIn"), makeKey("zoomOut"))
    : null;

  const speedId = `ptz-speed-${cam.id}`;
  const speedOut = h("output", { for: speedId, class: "num" });
  const slider = h("input", { type: "range", id: speedId, min: "0.1", max: "1", step: "0.05", "aria-label": "速度" });
  const paintSpeed = () => {
    const pct = `${Math.round(speed * 100)}%`;
    slider.value = String(speed);
    slider.style.setProperty("--fill", `${((speed - 0.1) / 0.9) * 100}%`);
    slider.setAttribute("aria-valuetext", pct);
    speedOut.textContent = pct;
  };
  slider.addEventListener("input", () => {
    speed = Number(slider.value);
    paintSpeed();
  });
  paintSpeed();

  const say = (text: string | null, tone: "info" | "error" = "info") => {
    note = text ? { text, tone } : null;
    paintStatus();
  };

  const presets = presetSection({
    cameraId: cam.id,
    presets: caps.presets,
    max: caps.maxPresets,
    admin,
    speed: () => speed,
    beforeGo: () => driver.cancel(),
    say,
  });

  const hint = plan.hold ? "按住持續轉動，點一下微調。" : "點一下移動一步。";

  const el = h(
    "section",
    { class: "ptz", "aria-label": "鏡頭控制" },
    h("div", { class: "ptz-head" }, h("h2", null, "鏡頭控制"), status),
    h("div", { class: "ptz-ctl", "data-zoom": caps.zoom ? "on" : "off" }, pad, zoom),
    h("label", { class: "ptz-speed", for: speedId }, h("span", null, "速度"), slider, speedOut),
    h("p", { class: "ptz-hint ptz-keys" }, hint, h("span", { class: "ptz-kbd" }, "也可以用方向鍵。")),
    presets,
  );

  const cancelAll = () => driver.cancel();
  const onKeyDown = (e: KeyboardEvent) => {
    const dir = KEY_DIR[e.key];
    if (!dir || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || document.hidden) return;
    if (dir.startsWith("zoom") && !caps.zoom) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, textarea, select, [contenteditable], dialog") || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    if (!e.repeat) driver.press(`k:${dir}`, VEC[dir]);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const dir = KEY_DIR[e.key];
    if (dir) driver.release(`k:${dir}`);
  };
  const onVisibility = () => document.hidden && cancelAll();
  const onPageHide = () => {
    const active = snap.held.length > 0 || snap.moving;
    cancelAll();
    if (active) stopOnUnload(cam.id);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", cancelAll);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    el,
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", cancelAll);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAll();
    },
  };
}
