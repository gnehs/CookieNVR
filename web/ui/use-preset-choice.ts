import { useRef, useState } from "react";

const toNumber = (s: string) => (s.trim() === "" ? NaN : Number(s));

/**
 * 「常用值＋自訂」的狀態：選到哪一個、自訂欄位的字，以及切到自訂時把焦點移進欄位。
 * onChange 收到目前的數值；自訂欄位不合法時是 NaN。
 */
export function usePresetChoice({ presets, initial, onChange, selectOnFocus }: { presets: { value: number }[]; initial: number; onChange: (v: number) => void; selectOnFocus?: boolean }) {
  const [picked, setPicked] = useState(presets.some((p) => p.value === initial) ? String(initial) : "custom");
  const [custom, setCustom] = useState(String(initial));
  const input = useRef<HTMLInputElement>(null);
  return {
    picked,
    custom,
    input,
    pick(v: string) {
      setPicked(v);
      if (v === "custom") {
        // 欄位要等這次重畫才出現，下一個畫面再移焦點
        requestAnimationFrame(() => {
          input.current?.focus();
          if (selectOnFocus) input.current?.select();
        });
        onChange(toNumber(custom));
      } else {
        setCustom(v);
        onChange(Number(v));
      }
    },
    type(value: string) {
      setCustom(value);
      onChange(toNumber(value));
    },
  };
}
