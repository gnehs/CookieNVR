import { ICONS, type IconName } from "./icons.ts";

/**
 * 雙色圖示（Phosphor duotone）：主線條是文字色（currentColor），淡色層（.duo）由 CSS 填不透明的混色。
 * 淡化請換實色，不要用 opacity：重疊的地方會疊出更深的顏色（常設指令第 3 條）。
 */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg viewBox="0 0 256 256" width={size} height={size} fill="currentColor" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
    </span>
  );
}
