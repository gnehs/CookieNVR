import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId } from "react";
import type { OnvifProbeDto } from "../../../src/api-types.ts";
import type { PtzMode, PtzPrefs } from "../../../src/types.ts";
import { SwitchRow, Tiles } from "../../ui/controls.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Slider } from "../../ui/Slider.tsx";

const modes = (): { value: PtzMode; label: string; desc: string }[] => [
  { value: "auto", label: t`Auto`, desc: t`Hold to turn if the camera supports it` },
  { value: "continuous", label: t`Hold to turn`, desc: t`Stops when you let go` },
  { value: "relative", label: t`Tap to step`, desc: t`Each tap turns a small step` },
];

export const ptzSummary = (p: PtzPrefs) => {
  const inverted = [p.invertPan && t`Pan reversed`, p.invertTilt && t`Tilt reversed`].filter(Boolean);
  const speed = `${Math.round(p.speed * 100)}%`;
  return [modes().find((m) => m.value === p.mode)!.label, t`Speed ${speed}`, ...inverted].join(" · ");
};

/** 攝影機設定裡的鏡頭控制偏好（移動方式、預設速度、方向反轉）。只有這台已知支援鏡頭控制時才出現 */
export function PtzPrefsField({ value, onChange }: { value: PtzPrefs; onChange: (p: PtzPrefs) => void }) {
  const { t } = useLingui();
  const speedId = useId();
  const pct = `${Math.round(value.speed * 100)}%`;
  return (
    <div className="form">
      <div className="field">
        <span className="legend">{t`Camera control`}</span>
        <Tiles label={t`Movement`} options={modes()} value={value.mode} onChange={(mode) => onChange({ ...value, mode })} />
      </div>
      <div className="ptz-speed">
        <span id={speedId}>{t`Default speed`}</span>
        <Slider min={0.1} max={1} step={0.05} aria-labelledby={speedId} aria-valuetext={pct} value={value.speed} onChange={(speed) => onChange({ ...value, speed })} />
        <output className="num">{pct}</output>
      </div>
      <SwitchRow title={t`Reverse left and right`} desc={t`Turn this on if pressing "Left" turns the camera right.`} checked={value.invertPan ?? false} onChange={(invertPan) => onChange({ ...value, invertPan })} />
      <SwitchRow title={t`Reverse up and down`} desc={t`If the camera is mounted upside down or flipped in its app, up and down are usually reversed too.`} checked={value.invertTilt ?? false} onChange={(invertTilt) => onChange({ ...value, invertTilt })} />
    </div>
  );
}

/** 測試連線成功後，若相機回報有 PTZ，用一句話告訴使用者 */
export function PtzSupportNote({ onvif }: { onvif: OnvifProbeDto }) {
  if (onvif.state !== "available" || !onvif.ptz) return null;
  return (
    <p className="success-note">
      <Icon name="crosshair" size={16} />
      {onvif.zoom ? <Trans>This camera can pan, tilt, and zoom. Control it from the live view.</Trans> : <Trans>This camera can pan and tilt. Control it from the live view.</Trans>}
    </p>
  );
}
