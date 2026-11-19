import logoUrl from "./assets/logo.png";
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any>;

const DOM_PROPS = new Set(["value", "checked", "disabled", "selected", "indeterminate"]);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
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

const ICONS: Record<string, string> = {
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2M20 20v-5h-5"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  logout: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M15 8l4 4-4 4M19 12H9"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  hdd: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M3 13l3-8h12l3 8M7 16.5v.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.5 2.3 3.5 5.2"/>',
  minus: '<path d="M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  "mic-off": '<path d="M15 9.5V6a3 3 0 0 0-5.8-1M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/>',
  "wifi-off": '<path d="M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 5.2-2.7M16.3 10.7a10 10 0 0 1 2.7 1.8M8.5 16a5 5 0 0 1 7 0M12 19.5v.01M3 3l18 18"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5v.01M7.5 16.5v.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>',
  tapo: '<rect x="6" y="3" width="12" height="13" rx="6"/><circle cx="12" cy="9.5" r="2.5"/><path d="M9 21h6M12 16v5"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  "volume-off": '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  expand: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.5"/>',
  "skip-end": '<path d="M6 5l9 7-9 7z"/><path d="M18 5v14"/>',
  rec: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.8 5.2-5.6"/>',
  "alert-circle": '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  selector: '<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  power: '<path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 18): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;
  return span;
}

export function toast(message: string, kind: "ok" | "error" = "ok") {
  const root = document.getElementById("toasts");
  if (!root) return;
  const el = h("div", { class: `toast ${kind}` }, icon(kind === "ok" ? "check" : "alert"), h("span", null, message));
  root.appendChild(el);
  const leave = () => {
    el.classList.add("leaving");
    // 減少動態效果時沒有 transition，transitionend 不會觸發
    setTimeout(() => el.remove(), 260);
  };
  setTimeout(leave, kind === "error" ? 6000 : 3200);
}

export function openDialog<T>(title: string, build: (close: (v?: T) => void) => Node): Promise<T | undefined> {
  return new Promise((resolve) => {
    let result: T | undefined;
    let closing = false;
    const titleId = nextId("dlg");
    const dlg = h("dialog", { class: "dlg", "aria-labelledby": titleId });
    const close = (v?: T) => {
      if (closing) return;
      closing = true;
      result = v;
      // 先播淡出再真的關閉；Esc 與點背景也走這條路
      dlg.dataset.closing = "";
      setTimeout(() => dlg.close(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 140);
    };
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    // 手機的底部面板要避開螢幕鍵盤：iOS 開鍵盤時只縮 visualViewport，不會推動 fixed 的 dialog
    const vv = window.visualViewport;
    const avoidKeyboard = () => {
      if (!vv) return;
      const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
      dlg.style.setProperty("--kb", `${Math.round(kb)}px`);
    };
    vv?.addEventListener("resize", avoidKeyboard);
    vv?.addEventListener("scroll", avoidKeyboard);
    dlg.addEventListener("close", () => {
      vv?.removeEventListener("resize", avoidKeyboard);
      vv?.removeEventListener("scroll", avoidKeyboard);
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close();
    });
    dlg.append(h("h2", { id: titleId }, title), build(close));
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

export async function confirmDialog(
  title: string,
  message: string,
  opts: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  const ok = await openDialog<boolean>(title, (close) =>
    h(
      "div",
      null,
      h("p", { class: "dlg-text" }, message),
      h(
        "div",
        { class: "dlg-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close(false) }, "取消"),
        h(
          "button",
          { class: `btn ${opts.danger ? "danger solid" : "primary"}`, type: "button", autofocus: true, onclick: () => close(true) },
          opts.confirmLabel ?? "確定",
        ),
      ),
    ),
  );
  return ok === true;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // LAN 以 http 存取時沒有 Clipboard API，退回選取後 execCommand
  const ta = h("textarea", { class: "sr-only", readonly: true }, text);
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  return ok;
}

export async function copyWithToast(text: string, label: string) {
  if (await copyText(text)) toast(`已複製${label}`);
  else toast("無法複製，請手動選取", "error");
}

/**
 * 複製按鈕：按下後在按鈕上換成打勾與「已複製」，同時用 toast 告知（toast 容器是 live region）。
 * 不在回饋期間停用按鈕，失敗後可以直接再按一次。
 */
export function copyButton(
  label: string,
  getText: () => string | Promise<string>,
  opts: { done?: string; class?: string; ariaLabel?: string } = {},
): HTMLButtonElement {
  const face = h("span", { class: "copy-face" }, icon("copy", 16), h("span", null, label));
  const btn = h("button", { class: `btn copy-btn ${opts.class ?? ""}`.trim(), type: "button", "aria-label": opts.ariaLabel }, face);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  btn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    btn.setAttribute("aria-busy", "true");
    let ok = false;
    const pending = Promise.resolve().then(getText);
    try {
      // 內容要等網路回來時，Safari 只接受在點擊當下交出 ClipboardItem（內容可以是之後才完成的 Promise）
      if (window.isSecureContext && "ClipboardItem" in window && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then((t) => new Blob([t], { type: "text/plain" })) })]);
        ok = true;
      }
    } catch {}
    if (!ok) {
      try {
        ok = await copyText(await pending);
      } catch {}
    }
    busy = false;
    btn.removeAttribute("aria-busy");
    clearTimeout(timer);
    face.replaceChildren(icon(ok ? "check" : "alert", 16), h("span", null, ok ? "已複製" : "複製失敗"));
    btn.dataset.state = ok ? "done" : "failed";
    toast(ok ? (opts.done ?? "已複製") : "無法複製，請再試一次", ok ? "ok" : "error");
    timer = setTimeout(() => {
      face.replaceChildren(icon("copy", 16), h("span", null, label));
      delete btn.dataset.state;
    }, 2200);
  });
  return btn;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(ms)}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${hh} 小時`;
  if (hh > 0) return `${hh} 小時 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

export function formatAgo(ms: number | null): string {
  if (ms == null) return "從未";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "剛剛";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`;
  return formatDateTime(ms).slice(0, 10);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let uid = 0;
export function nextId(prefix = "f"): string {
  return `${prefix}${++uid}`;
}

/** 帶 label 與說明文字的表單欄位，回傳 [容器, 輸入元素] */
export function field<T extends HTMLElement>(
  label: string,
  input: T,
  hint?: string,
): HTMLDivElement {
  const id = nextId();
  input.id = id;
  const wrap = h("div", { class: "field" }, h("label", { for: id }, label), input);
  if (hint) {
    const hid = `${id}-hint`;
    input.setAttribute("aria-describedby", hid);
    wrap.appendChild(h("small", { id: hid, class: "hint" }, hint));
  }
  return wrap;
}

export function badge(text: string, kind: "ok" | "bad" | "warn" | "muted" = "muted"): HTMLSpanElement {
  return h("span", { class: `badge ${kind}` }, text);
}

export function spinner(label = "載入中…"): HTMLElement {
  return h("div", { class: "state loading", role: "status" }, h("span", { class: "spin" }), h("span", null, label));
}

/** 整頁的載入、空白、錯誤三種狀態共用同一個置中版面 */
function stateBox(kind: "empty" | "error", iconName: string, title: string, body?: string, ...actions: Child[]): HTMLElement {
  return h(
    "div",
    { class: `state ${kind}`, role: kind === "error" ? "alert" : null },
    h("span", { class: "state-ico" }, icon(iconName, 22)),
    h("h3", null, title),
    body ? h("p", null, body) : null,
    actions.some(Boolean) ? h("div", { class: "state-actions" }, actions) : null,
  );
}

/** 頁面載入時的已知錯誤（例如找不到資料），自帶標題與主要動作；其他錯誤當成暫時性的，給「重新載入」 */
export class PageError extends Error {
  constructor(
    readonly title: string,
    message: string,
    readonly action: { label: string; href: string },
  ) {
    super(message);
  }
}

export function errorBox(message: string, retry?: () => void): HTMLElement {
  return stateBox(
    "error",
    "alert",
    "這裡暫時打不開",
    message,
    retry ? h("button", { class: "btn", type: "button", onclick: retry }, icon("refresh", 16), "重新載入") : null,
  );
}

export function pageErrorBox(e: PageError): HTMLElement {
  return stateBox("error", "alert", e.title, e.message, h("a", { class: "btn primary", href: e.action.href }, e.action.label));
}

export function emptyState(title: string, body?: string, action?: Node, iconName = "film"): HTMLElement {
  return stateBox("empty", iconName, title, body, action);
}

export function pageHeader(title: string, ...actions: Child[]): HTMLElement {
  return h("header", { class: "page-head" }, h("h1", null, title), actions.some(Boolean) ? h("div", { class: "page-actions" }, actions) : null);
}

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  /** 有 href 的項目是連結；沒有的是按鈕，選了呼叫 onSelect */
  href?: string;
  current?: boolean;
  /** 項目右邊的數字或提示（例如問題數） */
  badge?: string;
  badgeLabel?: string;
  onSelect?: () => void;
}

/** 選單裡的一組，帶一個小標題（例如「設定」底下的分頁） */
export interface MenuGroup {
  heading: string;
  items: MenuItem[];
}

export type MenuEntry = MenuItem | MenuGroup | null;

/**
 * 把觸發按鈕接上一個 popover 選單：放在 top layer，不會被面板的 overflow 裁掉；
 * 方向鍵在項目間移動，Esc 與點外面關閉並把焦點還給按鈕。手機上是底部面板（CSS）。
 */
export function attachMenu(btn: HTMLButtonElement, label: string, entries: MenuEntry[], opts: { align?: "start" | "end"; side?: "auto" | "top" } = {}): { menu: HTMLElement; wrap: HTMLElement } {
  const id = nextId("menu");
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", id);
  const focusables: HTMLElement[] = [];
  const item = (it: MenuItem) => {
    const body = [
      it.icon ? icon(it.icon, 16) : null,
      h("span", { class: "menu-label" }, it.label),
      it.badge ? h("span", { class: "menu-count", "aria-label": it.badgeLabel ?? null }, it.badge) : null,
    ];
    const cls = `menu-item${it.danger ? " danger" : ""}`;
    const el = it.href
      ? h("a", { class: cls, href: it.href, role: "menuitem", tabindex: "-1", "aria-current": it.current ? "page" : null, onclick: () => menu.hidePopover() }, body)
      : h("button", { class: cls, type: "button", role: "menuitem", tabindex: "-1", onclick: () => {
          menu.hidePopover();
          it.onSelect?.();
        } }, body);
    focusables.push(el);
    return el;
  };
  const children = entries.filter((e): e is MenuItem | MenuGroup => e !== null).map((e) => {
    if (!("heading" in e)) return item(e);
    const hid = nextId("mg");
    return h("div", { class: "menu-group", role: "group", "aria-labelledby": hid }, h("div", { class: "menu-heading", id: hid }, e.heading), e.items.map(item));
  });
  // 手機上是底部面板，面板頂端顯示選單在操作哪一列
  const menu = h("div", { class: "menu", id, role: "menu", "aria-label": label, popover: "auto" }, h("div", { class: "menu-title", "aria-hidden": "true" }, label), children);
  const place = () => {
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    const below = opts.side !== "top" && r.bottom + 6 + hgt <= innerHeight - 8;
    const left = opts.align === "start" ? r.left : r.right - w;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`;
    menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - hgt)}px`;
    menu.dataset.side = below ? "bottom" : "top";
    menu.dataset.align = opts.align ?? "end";
  };
  menu.addEventListener("toggle", (e) => {
    const open = (e as ToggleEvent).newState === "open";
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      place();
      focusables[0]?.focus();
    } else if (menu.contains(document.activeElement) || document.activeElement === document.body) btn.focus();
  });
  menu.addEventListener("keydown", (e) => {
    const i = focusables.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => focusables[(n + focusables.length) % focusables.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(focusables.length - 1);
    else if (e.key === "Tab") menu.hidePopover();
    else return;
    e.preventDefault();
  });
  btn.addEventListener("click", () => menu.togglePopover());
  return { menu, wrap: h("span", { class: "menu-wrap" }, btn, menu) };
}

/** 列上的「更多」選單 */
export function menuButton(label: string, items: (MenuItem | null)[]): HTMLElement {
  const btn = h("button", { class: "btn small icon-only ghost menu-btn", type: "button", "aria-label": label }, icon("more", 18));
  return attachMenu(btn, label, items).wrap;
}

/** 巢狀面板：外框帶標題列，內面板放 section，底部可選動作列 */
export function panel(
  opts: { title?: Child; back?: string; actions?: Child; foot?: Child; tag?: "section" | "form"; class?: string; flush?: boolean },
  ...sections: Child[]
): HTMLElement {
  const head =
    opts.title || opts.back || opts.actions
      ? h(
          "div",
          { class: "panel-head" },
          opts.back ? h("a", { class: "back-btn", href: opts.back, "aria-label": "返回" }, icon("left", 16)) : null,
          opts.title ? h("h2", null, opts.title) : h("span", { style: "flex:1" }),
          opts.actions,
        )
      : null;
  return h(
    opts.tag ?? "section",
    { class: `panel${opts.class ? ` ${opts.class}` : ""}`, novalidate: opts.tag === "form" ? true : null },
    head,
    h("div", { class: `panel-body${opts.flush ? " flush" : ""}` }, sections),
    opts.foot ? h("div", { class: "panel-foot" }, opts.foot) : null,
  );
}

export function panelSection(title: string | null, desc: string | null, ...content: Child[]): HTMLElement {
  return h(
    "div",
    { class: "panel-section" },
    title || desc ? h("header", null, title && h("h3", null, title), desc && h("p", null, desc)) : null,
    content,
  );
}

export function switchInput(checked: boolean, onChange?: (v: boolean) => void): HTMLInputElement {
  const input = h("input", { type: "checkbox", class: "switch", role: "switch", checked });
  if (onChange) input.addEventListener("change", () => onChange(input.checked));
  return input;
}

export function switchRow(input: HTMLInputElement, title: string, desc?: string): HTMLLabelElement {
  return h("label", { class: "switch-row" }, h("span", null, h("b", null, title), desc && h("small", null, desc)), input);
}

export interface TileOption<V extends string> {
  value: V;
  label: string;
  desc?: string;
  icon?: string;
}

/** 選項磚：用原生 radio 保留方向鍵切換與 radiogroup 語意 */
export function tiles<V extends string>(
  label: string,
  options: TileOption<V>[],
  value: V,
  onChange: (v: V) => void,
): HTMLElement {
  const name = nextId("tile");
  return h(
    "div",
    { class: "tiles", role: "radiogroup", "aria-label": label },
    options.map((o) => {
      const input = h("input", { type: "radio", name, value: o.value, checked: o.value === value, "aria-label": o.desc ? `${o.label}，${o.desc}` : o.label });
      input.addEventListener("change", () => input.checked && onChange(o.value));
      return h(
        "label",
        { class: "tile" },
        input,
        h(
          "span",
          { class: "tile-face" },
          o.icon ? h("span", { class: "tile-ico" }, icon(o.icon, 18)) : null,
          h("b", null, o.label),
          o.desc && h("small", null, o.desc),
        ),
      );
    }),
  );
}

/** 膠囊分段控制，適合 2–5 個短選項（例如時間軸的縮放級距） */
export function segmented<V extends string>(label: string, options: { value: V; label: string }[], value: V, onChange: (v: V) => void): HTMLElement {
  const name = nextId("seg");
  return h(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": label },
    options.map((o) => {
      const input = h("input", { type: "radio", name, value: o.value, checked: o.value === value });
      input.addEventListener("change", () => input.checked && onChange(o.value));
      return h("label", null, input, h("span", null, o.label));
    }),
  );
}

/**
 * 常用值＋自訂：先給幾個好選的選項，真的需要才展開數字欄位。
 * 回傳的 value() 一律讀目前選到的數值；自訂欄位不合法時回傳 NaN。
 */
export function choice(
  label: string,
  presets: { value: number; label: string }[],
  initial: number,
  unit: string,
  opts: { step?: number } = {},
): { el: HTMLElement; value: () => number; input: HTMLInputElement } {
  const custom = h("input", { type: "number", min: 0, step: String(opts.step ?? 1), inputmode: "decimal", "aria-label": `${label}（自訂，單位 ${unit}）` });
  custom.value = String(initial);
  const isPreset = presets.some((p) => p.value === initial);
  let picked: string = isPreset ? String(initial) : "custom";
  const customRow = h("div", { class: "choice-custom", hidden: picked !== "custom" }, custom, h("span", { class: "unit" }, unit));
  const seg = segmented(label, [...presets.map((p) => ({ value: String(p.value), label: p.label })), { value: "custom", label: "自訂" }], picked, (v) => {
    picked = v;
    customRow.hidden = v !== "custom";
    if (v === "custom") custom.focus();
    else custom.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const el = h("div", { class: "choice" }, seg, customRow);
  return { el, input: custom, value: () => (picked === "custom" ? (custom.value.trim() === "" ? NaN : Number(custom.value)) : Number(picked)) };
}

/** 品牌圖示：由 design/CookieNVR.icon 匯出 */
export function brandMark(): HTMLElement {
  return h("img", { class: "brand-mark", src: logoUrl, alt: "", width: "30", height: "30" });
}
