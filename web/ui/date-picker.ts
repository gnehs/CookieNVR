import { h, icon, nextId } from "../dom.ts";
import {
  addMonths,
  clampDay,
  dayOf,
  makeDay,
  monthGrid,
  monthOf,
  monthTitle,
  moveInGrid,
  shortDay,
  spokenDay,
  stepDay,
  WEEK_START,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  yearMonth,
  type DayKey,
  type GridKey,
} from "./date-logic.ts";
import { anchoredPopup } from "./popup.ts";

export interface DatePickerOpts {
  /** 給螢幕閱讀器的名稱，也是手機底部面板的標題 */
  label: string;
  value: DayKey | null;
  /** 選了日期，或按了清除選項（null） */
  onChange: (value: DayKey | null) => void;
  min?: DayKey | null;
  max?: DayKey | null;
  /** 有資料的日子，日曆上加一個小點 */
  marked?: ReadonlySet<string> | null;
  /** 念給螢幕閱讀器的「有資料」，例如「有錄影」 */
  markedLabel?: string;
  /** 只能選有資料的日子 */
  onlyMarked?: boolean;
  /** 有給的話，日曆底下多一個清除成 null 的按鈕（例如「所有日期」），沒有值時按鈕也顯示這個字 */
  clearLabel?: string;
  /** 按鈕上的字；預設是「今天」「昨天」「11/17 週二」 */
  format?: (day: DayKey, today: DayKey) => string;
  /** 按鈕兩側加上前一天、後一天（只會跳到可選的日子） */
  stepper?: boolean;
  class?: string;
}

export interface DatePickerHandle {
  el: HTMLElement;
  button: HTMLButtonElement;
  readonly value: DayKey | null;
  /** 從程式改值，不會呼叫 onChange */
  setValue(v: DayKey | null): void;
  setMarked(marked: ReadonlySet<string> | null): void;
  setRange(min: DayKey | null, max: DayKey | null): void;
  /** 重畫按鈕上的字（例如版面寬窄改變、跨過午夜） */
  repaint(): void;
}

const GRID_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const WEEK = Array.from({ length: 7 }, (_, i) => (WEEK_START + i) % 7);

/** 日期選擇：跟下拉選單同一種按鈕，點開是月曆（WAI-ARIA 日期選擇對話框：role="dialog" 裡一個 role="grid"） */
export function datePicker(opts: DatePickerOpts): DatePickerHandle {
  let value = opts.value;
  let min = opts.min ?? null;
  let max = opts.max ?? null;
  let marked = opts.marked ?? null;
  let today = dayOf(Date.now());
  let focusKey: DayKey = value ?? today;
  let view = yearMonth(focusKey);

  const labelId = nextId("dpl");
  const valueId = nextId("dpv");
  const titleId = nextId("dpt");
  const popId = nextId("dp");

  const selectable = (k: DayKey) => (!min || k >= min) && (!max || k <= max) && (!opts.onlyMarked || !!marked?.has(k));
  const fmt = (k: DayKey) => (opts.format ?? shortDay)(k, today);

  const valueEl = h("span", { class: "sel-value", id: valueId });
  const button = h(
    "button",
    { type: "button", class: "sel-trigger dp-trigger", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": popId, "aria-labelledby": `${labelId} ${valueId}` },
    icon("calendar", 17),
    valueEl,
    h("span", { class: "sel-chevron" }, icon("down", 16)),
  );

  const title = h("h2", { class: "dp-title", id: titleId, "aria-live": "polite" });
  const prevMonth = h("button", { type: "button", class: "btn ghost icon-only dp-nav", "aria-label": "上個月", onclick: () => shiftView(-1) }, icon("left", 18));
  const nextMonth = h("button", { type: "button", class: "btn ghost icon-only dp-nav", "aria-label": "下個月", onclick: () => shiftView(1) }, icon("right", 18));
  const body = h("tbody");
  const grid = h(
    "table",
    { class: "dp-grid", role: "grid", "aria-labelledby": titleId },
    h("thead", null, h("tr", null, WEEK.map((d) => h("th", { scope: "col", abbr: WEEKDAY_LONG[d] }, WEEKDAY_SHORT[d])))),
    body,
  );
  const todayBtn = h("button", { type: "button", class: "btn small", onclick: () => pick(today) }, "今天");
  const clearBtn = opts.clearLabel ? h("button", { type: "button", class: "btn small", onclick: () => pick(null) }, opts.clearLabel) : null;
  const foot = h("div", { class: "dp-foot" }, todayBtn, clearBtn);
  const pop = h(
    "div",
    { class: "dp-pop", id: popId, role: "dialog", "aria-label": `選擇${opts.label}` },
    h("div", { class: "popup-title", "aria-hidden": "true" }, opts.label),
    h("div", { class: "dp-head" }, prevMonth, title, nextMonth),
    grid,
    foot,
  );

  const popup = anchoredPopup(button, pop);

  const prevDay = opts.stepper ? h("button", { type: "button", class: "btn icon-only dp-step", "aria-label": "前一天", onclick: () => step(-1) }, icon("left", 18)) : null;
  const nextDay = opts.stepper ? h("button", { type: "button", class: "btn icon-only dp-step", "aria-label": "後一天", onclick: () => step(1) }, icon("right", 18)) : null;
  const el = h(
    "span",
    { class: `dp${opts.stepper ? " dp-has-step" : ""}${opts.class ? ` ${opts.class}` : ""}`, role: opts.stepper ? "group" : null, "aria-labelledby": opts.stepper ? labelId : null },
    h("span", { id: labelId, class: "sr-only" }, opts.label),
    prevDay,
    h("span", { class: "sel" }, button, pop),
    nextDay,
  );

  const near = (dir: 1 | -1, from: DayKey) => stepDay(from, dir, selectable, min, max);

  function paintTrigger() {
    today = dayOf(Date.now());
    valueEl.textContent = value ? fmt(value) : (opts.clearLabel ?? "選擇日期");
    button.toggleAttribute("data-placeholder", !value && !opts.clearLabel);
    if (prevDay && nextDay) {
      prevDay.disabled = !value || near(-1, value) === null;
      nextDay.disabled = !value || near(1, value) === null;
    }
  }

  function renderGrid() {
    const [y, m] = view;
    title.textContent = monthTitle(y, m);
    const firstOfView = makeDay(y, m, 1);
    prevMonth.disabled = !!min && monthOf(addMonths(firstOfView, -1)) < monthOf(min);
    nextMonth.disabled = !!max && monthOf(addMonths(firstOfView, 1)) > monthOf(max);
    const cells = monthGrid(y, m);
    const rows: HTMLTableRowElement[] = [];
    for (let r = 0; r < 6; r++) {
      rows.push(
        h(
          "tr",
          null,
          cells.slice(r * 7, r * 7 + 7).map((c) => {
            const ok = selectable(c.key);
            const has = !!marked?.has(c.key);
            const label = `${spokenDay(c.key)}${has && opts.markedLabel ? `，${opts.markedLabel}` : ""}${c.key === today ? "，今天" : ""}`;
            return h(
              "td",
              {
                role: "gridcell",
                class: "dp-day",
                tabindex: c.key === focusKey ? "0" : "-1",
                "data-key": c.key,
                "aria-label": label,
                "aria-selected": c.key === value ? "true" : null,
                "aria-current": c.key === today ? "date" : null,
                "aria-disabled": ok ? null : "true",
                "data-out": c.inMonth ? null : "",
                "data-marked": has ? "" : null,
              },
              h("span", { class: "dp-num" }, c.day),
            );
          }),
        ),
      );
    }
    body.replaceChildren(...rows);
    todayBtn.hidden = !selectable(today);
    if (clearBtn) clearBtn.setAttribute("aria-pressed", String(value === null));
    foot.hidden = todayBtn.hidden && !clearBtn;
  }

  function focusDay(k: DayKey, moveFocus: boolean) {
    focusKey = clampDay(k, min, max);
    const ym = yearMonth(focusKey);
    if (ym[0] !== view[0] || ym[1] !== view[1]) {
      view = ym;
      renderGrid();
    } else {
      for (const td of body.querySelectorAll<HTMLElement>("td")) td.tabIndex = td.dataset.key === focusKey ? 0 : -1;
    }
    if (moveFocus) body.querySelector<HTMLElement>(`td[data-key="${focusKey}"]`)?.focus();
  }

  function shiftView(n: number) {
    focusDay(addMonths(focusKey, n), false);
  }

  /** 打開時焦點在目前的值；沒有值時在今天，只能選有資料的日子時改到最近一個有資料的日子 */
  function initialFocus(): DayKey {
    if (value) return value;
    const t = clampDay(today, min, max);
    if (selectable(t)) return t;
    return near(-1, t) ?? near(1, t) ?? t;
  }

  function pick(k: DayKey | null) {
    if (k && !selectable(k)) return;
    popup.close(true);
    if (k === value) return;
    value = k;
    paintTrigger();
    opts.onChange(k);
  }

  function step(dir: 1 | -1) {
    if (!value) return;
    const k = near(dir, value);
    if (!k) return;
    value = k;
    paintTrigger();
    opts.onChange(k);
  }

  body.addEventListener("click", (e) => {
    const td = (e.target as Element).closest<HTMLElement>("td[data-key]");
    if (td) pick(td.dataset.key as DayKey);
  });
  body.addEventListener("keydown", (e) => {
    const td = (e.target as Element).closest<HTMLElement>("td[data-key]");
    if (!td) return;
    if (GRID_KEYS.has(e.key)) focusDay(moveInGrid(td.dataset.key as DayKey, e.key as GridKey, e.shiftKey), true);
    else if (e.key === "Enter" || e.key === " ") pick(td.dataset.key as DayKey);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  // 頁面上的快速鍵（例如回放的方向鍵）不要收到日曆裡的按鍵
  pop.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
  });

  function open(how: "pointer" | "keyboard") {
    today = dayOf(Date.now());
    focusKey = initialFocus();
    view = yearMonth(focusKey);
    renderGrid();
    popup.open(how);
    body.querySelector<HTMLElement>(`td[data-key="${focusKey}"]`)?.focus();
  }

  button.addEventListener("click", (e) => {
    if (popup.shouldOpenOnClick()) open(e.detail === 0 ? "keyboard" : "pointer");
    else popup.close();
  });
  button.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" || popup.isOpen) return;
    e.preventDefault();
    open("keyboard");
  });

  paintTrigger();

  return {
    el,
    button,
    get value() {
      return value;
    },
    setValue(v) {
      value = v;
      paintTrigger();
      if (popup.isOpen) renderGrid();
    },
    setMarked(m) {
      marked = m;
      paintTrigger();
      if (popup.isOpen) renderGrid();
    },
    setRange(a, b) {
      min = a;
      max = b;
      paintTrigger();
      if (popup.isOpen) renderGrid();
    },
    repaint: paintTrigger,
  };
}
