import { h, icon, pageHeader } from "../dom.ts";

export const SETTINGS_TABS = [
  ["cameras", "攝影機"],
  ["storage", "錄影與儲存"],
  ["system", "一般"],
  ["users", "使用者"],
  ["status", "狀態"],
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number][0];

export function settingsLayout(active: SettingsTab, content: Node): HTMLElement {
  return h(
    "div",
    { class: "form-page" },
    pageHeader("設定"),
    h(
      "nav",
      { class: "pill-nav", "aria-label": "設定分頁" },
      SETTINGS_TABS.map(([key, label]) => h("a", { href: `#/settings/${key}`, "aria-current": key === active ? "page" : null }, label)),
    ),
    content,
  );
}

/** 設定裡的子頁（新增、編輯）：不放分頁列，只留返回與標題 */
export function settingsSubpage(title: string, back: string, content: Node): HTMLElement {
  return h(
    "div",
    { class: "form-page" },
    h("header", { class: "page-head sub-head" }, h("a", { class: "back-btn", href: back, "aria-label": "返回" }, icon("left", 18)), h("h1", null, title)),
    content,
  );
}
