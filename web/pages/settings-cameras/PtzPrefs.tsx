import { useId } from "react";
import type { OnvifProbeDto } from "../../../src/api-types.ts";
import type { PtzMode, PtzPrefs } from "../../../src/types.ts";
import { Tiles } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";

const MODES: { value: PtzMode; label: string; desc: string }[] = [
  { value: "auto", label: "自動", desc: "相機支援就按住轉動" },
  { value: "continuous", label: "按住轉動", desc: "放開就停止" },
  { value: "relative", label: "點一下一步", desc: "每按一下轉一小步" },
];

export const ptzSummary = (p: PtzPrefs) => `${MODES.find((m) => m.value === p.mode)!.label} · 速度 ${Math.round(p.speed * 100)}%`;

/** 攝影機設定裡的鏡頭控制偏好（移動方式、預設速度）。只有這台已知支援鏡頭控制時才出現 */
export function PtzPrefsField({ value, onChange }: { value: PtzPrefs; onChange: (p: PtzPrefs) => void }) {
  const speedId = useId();
  const pct = `${Math.round(value.speed * 100)}%`;
  return (
    <div className="form">
      <div className="field">
        <span className="legend">鏡頭控制</span>
        <Tiles label="移動方式" options={MODES} value={value.mode} onChange={(mode) => onChange({ ...value, mode })} />
      </div>
      <label className="ptz-speed" htmlFor={speedId}>
        <span>預設速度</span>
        <input type="range" id={speedId} min={0.1} max={1} step={0.05} aria-label="預設速度" aria-valuetext={pct} value={value.speed} onChange={(e) => onChange({ ...value, speed: Number(e.currentTarget.value) })} />
        <output htmlFor={speedId} className="num">
          {pct}
        </output>
      </label>
    </div>
  );
}

/** 測試連線成功後，若相機回報有 PTZ，用一句話告訴使用者 */
export function PtzSupportNote({ onvif }: { onvif: OnvifProbeDto }) {
  if (onvif.state !== "available" || !onvif.ptz) return null;
  return (
    <p className="success-note">
      <Icon name="crosshair" size={16} />
      {onvif.zoom ? "這台可以轉動鏡頭與變焦，到即時畫面就能操作。" : "這台可以轉動鏡頭，到即時畫面就能操作。"}
    </p>
  );
}
