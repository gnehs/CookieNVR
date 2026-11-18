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
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
}

export function openDialog<T>(title: string, build: (close: (v?: T) => void) => Node): Promise<T | undefined> {
  return new Promise((resolve) => {
    let result: T | undefined;
    const dlg = h("dialog", { class: "dlg", "aria-labelledby": "dlg-title" });
    const close = (v?: T) => {
      result = v;
      dlg.close();
    };
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.append(h("h2", { id: "dlg-title" }, title), build(close));
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

export function spinner(): HTMLElement {
  return h("div", { class: "loading", role: "status" }, h("span", { class: "spin" }), "載入中");
}

export function errorBox(message: string, retry?: () => void): HTMLElement {
  return h(
    "div",
    { class: "callout bad", role: "alert" },
    icon("alert"),
    h("div", null, h("p", null, message), retry && h("button", { class: "btn small", type: "button", onclick: retry }, "重試")),
  );
}

export function emptyState(title: string, body?: string, action?: Node): HTMLElement {
  return h("div", { class: "empty" }, h("h3", null, title), body && h("p", null, body), action);
}

export function pageHeader(title: string, ...actions: Child[]): HTMLElement {
  return h("header", { class: "page-head" }, h("h1", null, title), h("div", { class: "page-actions" }, actions));
}
