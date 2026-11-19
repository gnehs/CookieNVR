import { h, icon } from "../dom.ts";

type Child = Node | string | null | undefined | false | Child[];

export interface FormCard {
  el: HTMLDetailsElement;
  body: HTMLElement;
  /** 收合時標題下面那一行：目前設定的摘要 */
  setSummary(text: string): void;
  /** error：裡面有欄位錯誤；dirty：有還沒儲存的變更。收合時也看得到 */
  setFlags(flags: { error?: boolean; dirty?: boolean }): void;
}

/**
 * 表單裡可以收合的一張卡片：標題列是 <summary>（鍵盤與螢幕閱讀器的展開狀態由瀏覽器提供），
 * 收合時顯示一行摘要，右邊是錯誤與未儲存的標示。以共用的 details.disclosure 為基礎，展開動畫一致。
 */
export function formCard(opts: { title: string; icon: string; open?: boolean; class?: string }, ...children: Child[]): FormCard {
  const summaryText = h("small", { class: "fcard-sub" });
  const errorFlag = h("span", { class: "fcard-flag error", hidden: true }, icon("alert-circle", 14), "有錯誤");
  const dirtyFlag = h("span", { class: "fcard-flag dirty", hidden: true }, h("i", { "aria-hidden": "true" }), "未儲存");
  const body = h("div", { class: "fcard-body" }, children);
  const el = h(
    "details",
    { class: `disclosure fcard${opts.class ? ` ${opts.class}` : ""}`, open: opts.open },
    h(
      "summary",
      null,
      h("span", { class: "fcard-ico" }, icon(opts.icon, 18)),
      h("span", { class: "fcard-text" }, h("b", null, opts.title), summaryText),
      h("span", { class: "fcard-flags" }, errorFlag, dirtyFlag),
      h("span", { class: "fcard-chevron" }, icon("down", 18)),
    ),
    body,
  );
  return {
    el,
    body,
    setSummary(text) {
      summaryText.textContent = text;
    },
    setFlags(f) {
      if (f.error !== undefined) {
        errorFlag.hidden = !f.error;
        el.toggleAttribute("data-error", f.error);
      }
      if (f.dirty !== undefined) {
        dirtyFlag.hidden = !f.dirty;
        el.toggleAttribute("data-dirty", f.dirty);
      }
    },
  };
}
