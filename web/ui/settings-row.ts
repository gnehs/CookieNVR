import { h, icon, nextId } from "../dom.ts";
import { select } from "./select.ts";

type Child = Node | string | null | undefined | false | Child[];

/**
 * 設定頁的版面：一組設定是一張卡片，卡片裡每一列左邊是標題與一行說明、右邊是控制項。
 * 卡片夠寬時左右兩欄對齊，窄的時候（容器查詢）上下堆疊。
 */
export function settingsGroup(opts: { title?: string; desc?: string; foot?: Child; class?: string }, ...rows: Child[]): HTMLElement {
  return h(
    "section",
    { class: `set-group${opts.class ? ` ${opts.class}` : ""}` },
    opts.title || opts.desc ? h("header", { class: "set-group-head" }, opts.title ? h("h2", null, opts.title) : null, opts.desc ? h("p", null, opts.desc) : null) : null,
    h("div", { class: "set-card" }, rows, opts.foot ? h("div", { class: "set-foot" }, opts.foot) : null),
  );
}

export interface SettingRowOpts {
  title: string;
  desc?: Child;
  control?: Child;
  /** 原生輸入框：標題用 <label for> 指向它 */
  input?: HTMLElement;
  /** 說明文字要掛在哪個可聚焦的元素上（aria-describedby）；預設是 input */
  describe?: HTMLElement;
  /** 控制項比較寬（例如文字欄位），窄螢幕以外也給它多一點空間 */
  wide?: boolean;
  class?: string;
}

export function settingRow(opts: SettingRowOpts): HTMLElement {
  const descId = opts.desc ? nextId("sd") : null;
  const target = opts.describe ?? opts.input;
  if (target && descId) target.setAttribute("aria-describedby", [target.getAttribute("aria-describedby"), descId].filter(Boolean).join(" "));
  let title: HTMLElement;
  if (opts.input) {
    opts.input.id ||= nextId("si");
    title = h("label", { class: "set-row-title", for: opts.input.id }, opts.title);
  } else title = h("div", { class: "set-row-title" }, opts.title);
  return h(
    "div",
    { class: `set-row${opts.wide ? " wide" : ""}${opts.class ? ` ${opts.class}` : ""}` },
    h("div", { class: "set-row-text" }, title, opts.desc ? h("div", { class: "set-row-desc", id: descId }, opts.desc) : null),
    opts.control || opts.input ? h("div", { class: "set-row-control" }, opts.control ?? opts.input) : null,
  );
}

/**
 * 卡片裡收合的一段（例如進階設定）：收合時是一列，標題旁邊顯示目前的值；展開後裡面的設定列跟上面同一種樣式。
 * 用共用的 details.disclosure，鍵盤與螢幕閱讀器的展開狀態是瀏覽器內建的。
 */
export function settingsDisclosure(title: string, summary: () => string, ...rows: Child[]): { el: HTMLDetailsElement; refresh: () => void } {
  const sub = h("small", null);
  const el = h(
    "details",
    { class: "disclosure set-disclosure" },
    h("summary", null, h("span", { class: "set-disclosure-text" }, h("b", null, title), sub), icon("down", 16)),
    h("div", { class: "disclosure-body" }, rows),
  );
  const refresh = () => (sub.textContent = summary());
  refresh();
  return { el, refresh };
}

export interface PresetPicker {
  el: HTMLElement;
  /** 目前的數值；自訂欄位不合法時是 NaN */
  value(): number;
  focusable: HTMLElement;
}

/**
 * 常用值的下拉選單＋「自訂…」：選自訂時在同一列出現數字欄位。
 * 值改變時在 el 上發出冒泡的 input 事件，表單可以統一監聽。
 */
export function presetPicker(label: string, presets: { value: number; label: string }[], initial: number, unit: string, opts: { step?: number } = {}): PresetPicker {
  const isPreset = presets.some((p) => p.value === initial);
  let picked = isPreset ? String(initial) : "custom";
  const custom = h("input", { type: "number", min: 0, step: String(opts.step ?? 1), inputmode: "decimal", class: "preset-custom", "aria-label": `${label}（自訂，單位 ${unit}）` });
  custom.value = String(initial);
  const customWrap = h("span", { class: "preset-custom-wrap", hidden: picked !== "custom" }, custom, h("span", { class: "unit" }, unit));
  const el = h("span", { class: "preset-pick" });
  const sel = select({
    label,
    entries: [...presets.map((p) => ({ value: String(p.value), label: p.label })), "separator", { value: "custom", label: "自訂…" }],
    value: picked,
    display: (o) => (o.value === "custom" ? "自訂" : o.label),
    onChange: (v) => {
      picked = v;
      customWrap.hidden = v !== "custom";
      if (v === "custom") {
        custom.focus();
        custom.select();
      } else custom.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });
  el.append(sel.el, customWrap);
  return {
    el,
    focusable: sel.button,
    value: () => (picked === "custom" ? (custom.value.trim() === "" ? NaN : Number(custom.value)) : Number(picked)),
  };
}
