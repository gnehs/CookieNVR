import { ICONS, type IconName } from "./icons.ts";

/** 線條圖示；顏色跟著文字色（currentColor）。淡化請換實色，不要用 opacity（常設指令第 3 條） */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: ICONS[name] }}
      />
    </span>
  );
}
