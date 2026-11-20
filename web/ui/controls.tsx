import { useLingui } from "@lingui/react/macro";
import { useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { useIndicator } from "./indicator.ts";

/** 開關：role="switch" 的原生 checkbox（`.switch`），表單與鍵盤行為都是瀏覽器內建的 */
export function Switch({
  checked,
  onChange,
  ...rest
}: { checked: boolean; onChange?: (v: boolean) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "checked" | "onChange" | "type">) {
  return <input {...rest} type="checkbox" className="switch" role="switch" checked={checked} onChange={(e) => onChange?.(e.currentTarget.checked)} />;
}

/** 整列都能點的開關（`.switch-row`）：左邊標題與說明，右邊開關 */
export function SwitchRow({ title, desc, checked, onChange, disabled }: { title: string; desc?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch-row">
      <span>
        <b>{title}</b>
        {desc ? <small>{desc}</small> : null}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

export interface TileOption<V extends string> {
  value: V;
  label: string;
  desc?: string;
  icon?: IconName;
}

/** 選項磚：用原生 radio 保留方向鍵切換與 radiogroup 語意 */
export function Tiles<V extends string>({ label, options, value, onChange }: { label: string; options: TileOption<V>[]; value: V; onChange: (v: V) => void }) {
  const { t } = useLingui();
  const name = useId();
  return (
    <div className="tiles" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const optLabel = o.label;
        const optDesc = o.desc;
        return (
          <label className="tile" key={o.value}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              aria-label={optDesc ? t`${optLabel}, ${optDesc}` : optLabel}
              onChange={(e) => e.currentTarget.checked && onChange(o.value)}
            />
            <span className="tile-face">
              {o.icon ? (
                <span className="tile-ico">
                  <Icon name={o.icon} size={18} />
                </span>
              ) : null}
              <b>{o.label}</b>
              {o.desc ? <small>{o.desc}</small> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** 膠囊分段控制，適合 2–5 個短選項（例如時間軸的縮放級距） */
export function Segmented<V extends string>({ label, options, value, onChange }: { label: string; options: { value: V; label: string }[]; value: V; onChange: (v: V) => void }) {
  const name = useId();
  const ind = useIndicator<HTMLDivElement>("label:has(input:checked)", value);
  return (
    <div className="segmented" role="radiogroup" aria-label={label} ref={ind.container}>
      <div className="ind seg-ind" ref={ind.block} aria-hidden="true" />
      {options.map((o) => (
        <label key={o.value}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={(e) => e.currentTarget.checked && onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * 常用值＋自訂：先給幾個好選的選項，真的需要才展開數字欄位。
 * onChange 收到目前選到的數值；自訂欄位不合法時是 NaN。
 */
export function Choice({
  label,
  presets,
  initial,
  unit,
  step = 1,
  onChange,
}: {
  label: string;
  presets: { value: number; label: string }[];
  initial: number;
  unit: string;
  step?: number;
  onChange: (v: number) => void;
}) {
  const { t } = useLingui();
  const [picked, setPicked] = useState(presets.some((p) => p.value === initial) ? String(initial) : "custom");
  const [custom, setCustom] = useState(String(initial));
  const input = useRef<HTMLInputElement>(null);
  const toNumber = (s: string) => (s.trim() === "" ? NaN : Number(s));
  return (
    <div className="choice">
      <Segmented
        label={label}
        options={[...presets.map((p) => ({ value: String(p.value), label: p.label })), { value: "custom", label: t`Custom` }]}
        value={picked}
        onChange={(v) => {
          setPicked(v);
          // 欄位要等這次重畫才出現，下一個畫面再移焦點
          if (v === "custom") requestAnimationFrame(() => input.current?.focus());
          else setCustom(v);
          onChange(v === "custom" ? toNumber(custom) : Number(v));
        }}
      />
      <div className="choice-custom" hidden={picked !== "custom"}>
        <input
          type="number"
          min={0}
          step={String(step)}
          inputMode="decimal"
          aria-label={t`${label} (custom, unit: ${unit})`}
          value={custom}
          ref={input}
          onChange={(e) => {
            setCustom(e.currentTarget.value);
            onChange(toNumber(e.currentTarget.value));
          }}
        />
        <span className="unit">{unit}</span>
      </div>
    </div>
  );
}
