// index.html 的 inline script 在首次繪製前用同樣的 key 套用偏好，兩邊要一起改
const MODE_KEY = "cookienvr.color-scheme";
const ACCENT_KEY = "cookienvr.accent";

export type ColorMode = "light" | "dark" | "system";

export const ACCENTS = [
  { id: "blue", label: "藍" },
  { id: "indigo", label: "靛" },
  { id: "violet", label: "紫" },
  { id: "pink", label: "粉" },
  { id: "orange", label: "橘" },
  { id: "green", label: "綠" },
  { id: "teal", label: "青" },
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

export const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)");

window.addEventListener("storage", (e) => {
  if (e.key === MODE_KEY) applyMode(getMode());
  if (e.key === ACCENT_KEY) applyAccent(getAccent());
});
