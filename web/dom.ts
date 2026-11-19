// 給命令式物件（canvas 時間軸、偵測遮罩編輯器）自己建 DOM 用的小工具；React 元件不要用它，改用 JSX 與 `ui/Icon.tsx`
import { ICONS } from "./ui/icons.ts";

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any>;

const DOM_PROPS = new Set(["value", "checked", "disabled", "selected", "indeterminate"]);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (DOM_PROPS.has(key)) (el as any)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(parent: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

export function icon(name: string, size = 18): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${(ICONS as Record<string, string>)[name] ?? ""}</svg>`;
  return span;
}
