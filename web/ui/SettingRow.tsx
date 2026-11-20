import { useLingui } from "@lingui/react/macro";
import { useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { Select } from "./Select.tsx";

/**
 * 設定頁的版面：一組設定是一張卡片，卡片裡每一列左邊是標題與一行說明、右邊是控制項。
 * 卡片夠寬時左右兩欄對齊，窄的時候（容器查詢）上下堆疊。
 */
export function SettingsGroup({ title, desc, foot, className, children }: { title?: string; desc?: string; foot?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <section className={`set-group${className ? ` ${className}` : ""}`}>
      {title || desc ? (
        <header className="set-group-head">
          {title ? <h2>{title}</h2> : null}
          {desc ? <p>{desc}</p> : null}
        </header>
      ) : null}
      <div className="set-card">
        {children}
        {foot ? <div className="set-foot">{foot}</div> : null}
      </div>
    </section>
  );
}

/** 控制項要接上的無障礙屬性：標題的 `<label htmlFor>` 指向 id，說明文字用 aria-describedby */
export interface RowA11y {
  id: string;
  "aria-describedby"?: string;
}

export interface SettingRowProps {
  title: string;
  desc?: ReactNode;
  /**
   * 右邊的控制項。給函式時會拿到 id 與 aria-describedby，標題變成指向它的 `<label>`；
   * 給元素時標題只是文字（例如一組按鈕）。
   */
  control?: ReactNode | ((a11y: RowA11y) => ReactNode);
  /** 開關列：整列都能點（開關本身只有 42×25），說明裡的連結與按鈕照常運作 */
  toggle?: boolean;
  /** 控制項比較寬（例如文字欄位），窄螢幕以外也給它多一點空間 */
  wide?: boolean;
  className?: string;
  /** 列底下的欄位錯誤（`.field-error`） */
  error?: ReactNode;
}

export function SettingRow({ title, desc, control, toggle, wide, className, error }: SettingRowProps) {
  const id = useId();
  const descId = desc ? `${id}-desc` : undefined;
  const row = useRef<HTMLDivElement>(null);
  const labelled = typeof control === "function";
  const content = labelled ? control({ id, "aria-describedby": descId }) : control;
  return (
    <div
      ref={row}
      className={`set-row${wide ? " wide" : ""}${toggle ? " is-toggle" : ""}${className ? ` ${className}` : ""}`}
      onClick={
        toggle
          ? (e) => {
              const sw = row.current?.querySelector<HTMLInputElement>('input[type="checkbox"]');
              // 只看列裡面的互動元素：列本身常放在可收合的卡片（details）裡
              const hit = (e.target as Element).closest("a, button, summary, details, input, label, select, textarea");
              if (!sw || sw.disabled || (hit && row.current?.contains(hit))) return;
              sw.click();
            }
          : undefined
      }
    >
      <div className="set-row-text">
        {labelled ? (
          <label className="set-row-title" htmlFor={id}>
            {title}
          </label>
        ) : (
          <div className="set-row-title">{title}</div>
        )}
        {desc ? (
          <div className="set-row-desc" id={descId}>
            {desc}
          </div>
        ) : null}
      </div>
      {content ? <div className="set-row-control">{content}</div> : null}
      {error ? (
        <p className="field-error" role="alert">
          <Icon name="alert-circle" size={15} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * 卡片裡收合的一段（例如進階設定）：收合時是一列，標題旁邊顯示目前的值；展開後裡面的設定列跟上面同一種樣式。
 * 原生 details（`.disclosure`），展開狀態與鍵盤操作是瀏覽器內建的。
 */
export function SettingsDisclosure({ title, summary, children }: { title: string; summary: string; children?: ReactNode }) {
  return (
    <details className="disclosure set-disclosure">
      <summary>
        <span className="set-disclosure-text">
          <b>{title}</b>
          <small>{summary}</small>
        </span>
        <Icon name="down" size={16} />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/**
 * 常用值的下拉選單＋「自訂…」：選自訂時在同一列出現數字欄位。
 * onChange 收到目前的數值；自訂欄位不合法時是 NaN。
 */
export function PresetPicker({
  label,
  presets,
  initial,
  unit,
  step = 1,
  onChange,
  id,
  "aria-describedby": describedBy,
}: {
  label: string;
  presets: { value: number; label: string }[];
  initial: number;
  unit: string;
  step?: number;
  onChange: (v: number) => void;
} & Partial<RowA11y>) {
  const { t } = useLingui();
  const [picked, setPicked] = useState(presets.some((p) => p.value === initial) ? String(initial) : "custom");
  const [custom, setCustom] = useState(String(initial));
  const input = useRef<HTMLInputElement>(null);
  const toNumber = (s: string) => (s.trim() === "" ? NaN : Number(s));
  return (
    <span className="preset-pick">
      <Select
        id={id}
        aria-describedby={describedBy}
        label={label}
        entries={[...presets.map((p) => ({ value: String(p.value), label: p.label })), "separator", { value: "custom", label: t`Custom…` }]}
        value={picked}
        display={(o) => (o.value === "custom" ? t`Custom` : o.label)}
        onChange={(v) => {
          setPicked(v);
          if (v === "custom") {
            requestAnimationFrame(() => {
              input.current?.focus();
              input.current?.select();
            });
            onChange(toNumber(custom));
          } else {
            setCustom(v);
            onChange(Number(v));
          }
        }}
      />
      <span className="preset-custom-wrap" hidden={picked !== "custom"}>
        <input
          ref={input}
          type="number"
          min={0}
          step={String(step)}
          inputMode="decimal"
          className="preset-custom"
          aria-label={t`${label} (custom, unit: ${unit})`}
          value={custom}
          onChange={(e) => {
            setCustom(e.currentTarget.value);
            onChange(toNumber(e.currentTarget.value));
          }}
        />
        <span className="unit">{unit}</span>
      </span>
    </span>
  );
}
