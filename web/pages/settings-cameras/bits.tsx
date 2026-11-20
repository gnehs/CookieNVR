import { useState, type ReactNode } from "react";
import { Icon } from "../../ui/Icon.tsx";
import { Slider } from "../../ui/Slider.tsx";

/**
 * 同 `ui/SettingRow.tsx` 的 SettingsDisclosure，多了 defaultOpen：有不是預設值的進階設定時一打開就展開。
 * 只在第一次畫出來時生效，之後展開狀態歸瀏覽器管。
 */
export function Disclosure({ title, summary, defaultOpen, children }: { title: string; summary: string; defaultOpen?: boolean; children?: ReactNode }) {
  const [initial] = useState(defaultOpen);
  return (
    <details className="disclosure set-disclosure" open={initial}>
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

/** 0 到 100 的滑桿；位置自己記著，換算成設定值的四捨五入不會讓滑桿跳動 */
export function Range({ initial, onInput, step = 0.5, ...aria }: { initial: number; onInput: (pos: number) => void; step?: number; "aria-label"?: string; "aria-labelledby"?: string; "aria-valuetext"?: string }) {
  const [pos, setPos] = useState(initial);
  return (
    <Slider
      value={pos}
      step={step}
      {...aria}
      onChange={(v) => {
        setPos(v);
        onInput(v);
      }}
    />
  );
}
