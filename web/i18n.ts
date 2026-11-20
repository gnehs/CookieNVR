import { i18n, type Messages } from "@lingui/core";

const LOCALE_KEY = "cookienvr.locale";

/** 介面語言；label 用該語言自己的寫法，切換時不管目前是哪個語言都認得出來 */
export const LOCALES = [
  { id: "en", label: "English" },
  { id: "zh-Hant", label: "繁體中文" },
  { id: "ja", label: "日本語" },
] as const;

export type Locale = (typeof LOCALES)[number]["id"];
export type LocalePref = Locale | "system";

const catalogs = import.meta.glob<{ messages: Messages }>("./locales/*.po");

const isLocale = (v: string | null): v is Locale => LOCALES.some((l) => l.id === v);

export function getLocalePref(): LocalePref {
  let v: string | null = null;
  try {
    v = localStorage.getItem(LOCALE_KEY);
  } catch {}
  return isLocale(v) ? v : "system";
}

/** 簡體中文的使用者也給繁體：比英文好讀 */
export function systemLocale(): Locale {
  for (const tag of navigator.languages) {
    const lang = tag.toLowerCase();
    if (lang.startsWith("zh")) return "zh-Hant";
    if (lang.startsWith("ja")) return "ja";
    if (lang.startsWith("en")) return "en";
  }
  return "en";
}

const resolve = (pref: LocalePref): Locale => (pref === "system" ? systemLocale() : pref);

export async function activateLocale(pref: LocalePref = getLocalePref()): Promise<void> {
  const locale = resolve(pref);
  const { messages } = await catalogs[`./locales/${locale}.po`]!();
  i18n.loadAndActivate({ locale, messages });
  document.documentElement.lang = locale;
}

export async function setLocalePref(pref: LocalePref): Promise<void> {
  try {
    if (pref === "system") localStorage.removeItem(LOCALE_KEY);
    else localStorage.setItem(LOCALE_KEY, pref);
  } catch {}
  await activateLocale(pref);
}
