import { h, pageHeader } from "../dom.ts";

const TABS = [
  ["cameras", "攝影機"],
  ["storage", "錄影與儲存"],
  ["system", "系統"],
  ["users", "使用者"],
  ["status", "狀態"],
] as const;

export type SettingsTab = (typeof TABS)[number][0];

export function settingsLayout(active: SettingsTab, title: string, content: Node, ...actions: Node[]): HTMLElement {
  return h(
    "div",
    null,
    pageHeader("設定"),
    h(
      "nav",
      { class: "tabs", "aria-label": "設定分頁" },
      TABS.map(([key, label]) => h("a", { class: "tab", href: `#/settings/${key}`, "aria-current": key === active ? "page" : null }, label)),
    ),
    actions.length > 0
      ? h("div", { class: "page-head", style: "margin-bottom:14px" }, h("h2", { style: "font-size:17px" }, title), h("div", { class: "page-actions" }, actions))
      : null,
    content,
  );
}
