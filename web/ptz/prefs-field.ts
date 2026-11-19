import type { CameraDto, OnvifProbeDto } from "../../src/api-types.ts";
import type { PtzMode, PtzPrefs } from "../../src/types.ts";
import { api } from "../api.ts";
import { h, icon, nextId, tiles } from "../dom.ts";

const MODES: { value: PtzMode; label: string; desc: string }[] = [
  { value: "auto", label: "自動", desc: "相機支援就按住轉動" },
  { value: "continuous", label: "按住轉動", desc: "放開就停止" },
  { value: "relative", label: "點一下一步", desc: "每按一下轉一小步" },
];

/**
 * 攝影機設定裡的鏡頭控制偏好（移動方式、預設速度）。只有這台已知支援鏡頭控制時才出現，
 * 其他時候整段不佔位，儲存時沿用原本的設定。
 */
export function ptzPrefsField(existing: CameraDto | null): { el: HTMLElement; value: () => PtzPrefs | undefined; supported: Promise<boolean>; summary: () => string } {
  let prefs: PtzPrefs = { mode: existing?.config.ptz?.mode ?? "auto", speed: existing?.config.ptz?.speed ?? 0.5 };
  let touched = false;

  const speedId = nextId("ptz-speed");
  const out = h("output", { for: speedId, class: "num" });
  const slider = h("input", { type: "range", id: speedId, min: "0.1", max: "1", step: "0.05", "aria-label": "預設速度" });
  const paint = () => {
    slider.value = String(prefs.speed);
    out.textContent = `${Math.round(prefs.speed * 100)}%`;
    slider.setAttribute("aria-valuetext", out.textContent);
  };
  slider.addEventListener("input", () => {
    touched = true;
    prefs = { ...prefs, speed: Number(slider.value) };
    paint();
  });
  paint();

  const el = h(
    "div",
    { class: "form", hidden: true },
    h(
      "div",
      { class: "field" },
      h("span", { class: "legend" }, "鏡頭控制"),
      tiles("移動方式", MODES, prefs.mode, (mode) => {
        touched = true;
        prefs = { ...prefs, mode };
      }),
    ),
    h("label", { class: "ptz-speed", for: speedId }, h("span", null, "預設速度"), slider, out),
  );

  const supported = existing
    ? api.ptz(existing.id).then(
        (d) => {
          if (d.supported) el.hidden = false;
          return d.supported;
        },
        () => false,
      )
    : Promise.resolve(false);

  return {
    el,
    value: () => (touched || existing?.config.ptz ? prefs : undefined),
    supported,
    summary: () => `${MODES.find((m) => m.value === prefs.mode)!.label} · 速度 ${Math.round(prefs.speed * 100)}%`,
  };
}

/** 測試連線成功後，若相機回報有 PTZ，用一句話告訴使用者 */
export function ptzSupportNote(onvif: OnvifProbeDto): HTMLElement | null {
  if (onvif.state !== "available" || !onvif.ptz) return null;
  return h("p", { class: "success-note" }, icon("crosshair", 16), onvif.zoom ? "這台可以轉動鏡頭與變焦，到即時畫面就能操作。" : "這台可以轉動鏡頭，到即時畫面就能操作。");
}
