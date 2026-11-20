import { ICONS, type IconName } from "./icons.ts";

/**
 * 自己畫的雙色圖示（屬性與 icons.ts 的 ICON_SVG_ATTRS 相同，dom.ts 用那一份）：線條是文字色（currentColor），主體的淡色層（.duo）由 CSS 填不透明的混色。
 * 淡化請換實色，不要用 opacity：重疊的地方會疊出更深的顏色（常設指令第 3 條）。
 */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: ICONS[name] }}
      />
    </span>
  );
}
