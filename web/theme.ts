import { msg } from "@lingui/core/macro";

// index.html 的 inline script 在首次繪製前用同樣的 key 套用偏好，兩邊要一起改
const MODE_KEY = "cookienvr.color-scheme";
const ACCENT_KEY = "cookienvr.accent";
const SIDEBAR_KEY = "cookienvr.sidebar";

export type ColorMode = "light" | "dark" | "system";

export const ACCENTS = [
  { id: "blue", label: msg`Blue` },
  { id: "indigo", label: msg`Indigo` },
  { id: "violet", label: msg`Violet` },
  { id: "pink", label: msg`Pink` },
  { id: "orange", label: msg`Orange` },
  { id: "green", label: msg`Green` },
  { id: "teal", label: msg`Teal` },
] as const;

export type Accent = (typeof ACCENTS)[number]["id"];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

const isAccent = (v: string | null): v is Accent => ACCENTS.some((a) => a.id === v);

export function getMode(): ColorMode {
  const v = read(MODE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function getAccent(): Accent {
  const v = read(ACCENT_KEY);
  return isAccent(v) ? v : "blue";
}

function applyMode(mode: ColorMode) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.content = mode === "system" ? "light dark" : mode;
}

function applyAccent(accent: Accent) {
  document.documentElement.dataset.accent = accent;
}

export function setMode(mode: ColorMode) {
  write(MODE_KEY, mode === "system" ? null : mode);
  applyMode(mode);
}

export function setAccent(accent: Accent) {
  write(ACCENT_KEY, accent === "blue" ? null : accent);
  applyAccent(accent);
}

/** 桌面側欄收合成只剩圖示；狀態掛在 <html data-sidebar>，首次繪製前由 index.html 套用 */
export function getSidebarCollapsed(): boolean {
  return document.documentElement.dataset.sidebar === "collapsed";
}

export function setSidebarCollapsed(collapsed: boolean) {
  write(SIDEBAR_KEY, collapsed ? "collapsed" : null);
  if (collapsed) document.documentElement.dataset.sidebar = "collapsed";
  else delete document.documentElement.dataset.sidebar;
}

export const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)");

window.addEventListener("storage", (e) => {
  if (e.key === MODE_KEY) applyMode(getMode());
  if (e.key === ACCENT_KEY) applyAccent(getAccent());
});
