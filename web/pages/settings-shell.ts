import { h, pageHeader } from "../dom.ts";

const TABS = [
  ["cameras", "攝影機"],
  ["storage", "錄影與儲存"],
  ["system", "一般"],
  ["users", "使用者"],
  ["status", "狀態"],
] as const;

export type SettingsTab = (typeof TABS)[number][0];

export function settingsLayout(active: SettingsTab, content: Node): HTMLElement {
  return h(
    "div",
    null,
    pageHeader("設定"),
    h(
      "nav",
      { class: "pill-nav", "aria-label": "設定分頁" },
      TABS.map(([key, label]) => h("a", { href: `#/settings/${key}`, "aria-current": key === active ? "page" : null }, label)),
    ),
    content,
  );
}
