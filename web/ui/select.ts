import { h, icon, nextId } from "../dom.ts";
import { anchoredPopup } from "./popup.ts";
import { CLOSED, keepActive, NO_TYPEAHEAD, openAt, selectKey, type ListState, type Typeahead } from "./select-logic.ts";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  icon?: string;
  /** 項目下方的次要說明 */
  desc?: string;
  disabled?: boolean;
}

export interface SelectGroup<V extends string> {
  heading: string;
  options: SelectOption<V>[];
}

export type SelectEntry<V extends string> = SelectOption<V> | SelectGroup<V> | "separator";

export interface SelectOpts<V extends string> {
  /** 給螢幕閱讀器的名稱，也是手機底部面板的標題 */
  label: string;
  entries: SelectEntry<V>[];
  value: V | null;
  onChange: (value: V) => void;
  /** 按鈕裡值前面的圖示 */
  icon?: string;
  /** 沒有值時按鈕上的字 */
  placeholder?: string;
  /** 按鈕上顯示的字；預設是選項的 label（例如倍速只顯示「2×」） */
  display?: (o: SelectOption<V>) => string;
  /** 放在表單裡時，用這個名稱帶出目前的值 */
  name?: string;
  /** quiet：播放器控制列上的無框樣式 */
  variant?: "quiet";
  class?: string;
  disabled?: boolean;
}

export interface SelectHandle<V extends string> {
  el: HTMLElement;
  button: HTMLButtonElement;
  readonly value: V | null;
  /** 從程式改值，不會呼叫 onChange */
  setValue(v: V | null): void;
  /** 換選項；清單開著時保持開著，反白與焦點留在同一個值上 */
  setEntries(entries: SelectEntry<V>[]): void;
  setDisabled(disabled: boolean): void;
}

const isGroup = <V extends string>(e: SelectEntry<V>): e is SelectGroup<V> => typeof e === "object" && "heading" in e;
const flatten = <V extends string>(entries: SelectEntry<V>[]) => entries.flatMap((e) => (e === "separator" ? [] : isGroup(e) ? e.options : [e]));

/**
 * 下拉選單：觸發按鈕＋浮動的選項清單（role="combobox" 搭 role="listbox"）。
 * 開啟時焦點移到目前的值，方向鍵、Home／End、輸入字母移動，Enter／空白鍵選取，Esc 關閉並把焦點還給按鈕。
 */
export function select<V extends string>(opts: SelectOpts<V>): SelectHandle<V> {
  const listId = nextId("lb");
  const labelId = nextId("lbl");
  const valueId = nextId("val");
  let entries = opts.entries;
  let options = flatten(entries);
  let value = opts.value;
  let state: ListState = CLOSED;
  let ta: Typeahead = NO_TYPEAHEAD;
  let optionEls: HTMLElement[] = [];

  const valueEl = h("span", { class: "sel-value", id: valueId });
  const button = h(
    "button",
    {
      type: "button",
      class: `sel-trigger${opts.variant === "quiet" ? " quiet" : ""}${opts.class ? ` ${opts.class}` : ""}`,
      role: "combobox",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": listId,
      // 名稱念「攝影機」，值念目前選到的「客廳」
      "aria-labelledby": `${labelId} ${valueId}`,
      disabled: opts.disabled,
    },
    opts.icon ? icon(opts.icon, 17) : null,
    valueEl,
    h("span", { class: "sel-chevron" }, icon("down", 16)),
  );
  const list = h("div", { class: "sel-pop", id: listId, role: "listbox", "aria-labelledby": labelId, tabindex: "-1" });
  const hidden = opts.name ? h("input", { type: "hidden", name: opts.name }) : null;
  const el = h("span", { class: "sel" }, h("span", { id: labelId, class: "sr-only" }, opts.label), button, list, hidden);

  const indexOf = (v: V | null) => (v === null ? -1 : options.findIndex((o) => o.value === v));

  const popup = anchoredPopup(button, list, {
    onClose: () => {
      state = CLOSED;
      ta = NO_TYPEAHEAD;
    },
  });

  function paintValue() {
    const o = options[indexOf(value)];
    valueEl.textContent = o ? (opts.display?.(o) ?? o.label) : (opts.placeholder ?? "");
    button.toggleAttribute("data-placeholder", !o);
    if (hidden) hidden.value = value ?? "";
    optionEls.forEach((elx, i) => elx.setAttribute("aria-selected", String(options[i]!.value === value)));
  }

  function optionEl(o: SelectOption<V>): HTMLElement {
    const i = optionEls.length;
    const node = h(
      "div",
      {
        class: "sel-opt",
        role: "option",
        id: `${listId}-${i}`,
        tabindex: "-1",
        "aria-selected": "false",
        "aria-disabled": o.disabled ? "true" : null,
        onclick: () => !o.disabled && commit(i, true),
        // 滑鼠移過去就反白，跟鍵盤移動是同一個狀態
        onpointermove: (e: PointerEvent) => {
          if (e.pointerType === "mouse" && !o.disabled && state.open && state.active !== i) activate(i);
        },
      },
      o.icon ? icon(o.icon, 17) : null,
      h("span", { class: "sel-opt-text" }, h("span", null, o.label), o.desc ? h("small", null, o.desc) : null),
      h("span", { class: "sel-check" }, icon("check", 16)),
    );
    optionEls.push(node);
    return node;
  }

  function renderList() {
    optionEls = [];
    list.replaceChildren(
      h("div", { class: "popup-title", "aria-hidden": "true" }, opts.label),
      ...entries.map((e) => {
        if (e === "separator") return h("div", { class: "sel-sep", role: "separator" });
        if (!isGroup(e)) return optionEl(e);
        const hid = nextId("sg");
        return h("div", { class: "sel-group", role: "group", "aria-labelledby": hid }, h("div", { class: "sel-heading", id: hid }, e.heading), e.options.map(optionEl));
      }),
    );
    paintValue();
  }

  /** 反白並把焦點放到項目上；清單會捲到看得到它 */
  function activate(i: number, scroll = true) {
    state = { open: true, active: i };
    optionEls.forEach((o, j) => o.toggleAttribute("data-highlighted", j === i));
    const target = optionEls[i];
    if (!target) return;
    target.focus({ preventScroll: true });
    if (scroll) {
      const top = target.offsetTop;
      const bottom = top + target.offsetHeight;
      if (top < list.scrollTop + 4) list.scrollTop = top - 4;
      else if (bottom > list.scrollTop + list.clientHeight - 4) list.scrollTop = bottom - list.clientHeight + 4;
    }
  }

  function open(how: "pointer" | "keyboard", at: ListState) {
    if (!at.open) return;
    popup.open(how);
    // 開啟時目前的值放在清單中間附近，長清單一打開就看得到前後的選項
    const target = optionEls[at.active];
    if (target) list.scrollTop = target.offsetTop - list.clientHeight / 2 + target.offsetHeight / 2;
    activate(at.active, false);
  }

  function commit(i: number, restoreFocus: boolean) {
    const o = options[i];
    popup.close(restoreFocus);
    if (!o || o.disabled || o.value === value) return;
    value = o.value;
    paintValue();
    opts.onChange(o.value);
  }

  function onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    const wasOpen = popup.isOpen;
    const r = selectKey(wasOpen ? state : CLOSED, ta, options, indexOf(value), { key: e.key, now: e.timeStamp, alt: e.altKey, mod: e.ctrlKey || e.metaKey });
    ta = r.typeahead;
    if (r.handled) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (r.commit !== null) return commit(r.commit, r.restoreFocus);
    if (!r.state.open) {
      if (wasOpen) popup.close(r.restoreFocus);
      return;
    }
    if (!wasOpen) open("keyboard", r.state);
    else activate(r.state.active);
  }

  button.addEventListener("keydown", onKey);
  list.addEventListener("keydown", onKey);
  button.addEventListener("click", (e) => {
    // 鍵盤已經在 keydown 處理過；這裡只管滑鼠與觸控
    if (e.detail === 0) return;
    if (popup.shouldOpenOnClick()) open("pointer", openAt(options, indexOf(value)));
    else popup.close();
  });

  renderList();

  return {
    el,
    button,
    get value() {
      return value;
    },
    setValue(v) {
      value = v;
      paintValue();
    },
    setEntries(next) {
      const prevValues = options.map((o) => o.value as string);
      const focusInside = list.contains(document.activeElement);
      entries = next;
      options = flatten(next);
      const kept = keepActive(prevValues, options, state);
      const top = list.scrollTop;
      renderList();
      list.scrollTop = top;
      if (!popup.isOpen) return;
      if (!kept.open) return popup.close(focusInside);
      if (focusInside) activate(kept.active, false);
      else {
        state = kept;
        optionEls[kept.active]?.toggleAttribute("data-highlighted", true);
      }
    },
    setDisabled(d) {
      button.disabled = d;
      if (d) popup.close(false);
    },
  };
}
