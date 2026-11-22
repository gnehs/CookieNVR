import { useState } from "react";
import { Slider } from "../../ui/Slider.tsx";

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
