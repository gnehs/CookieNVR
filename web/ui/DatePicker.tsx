import { Popover } from "@base-ui/react/popover";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
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

export interface DatePickerProps {
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
  className?: string;
}

const GRID_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const WEEK = Array.from({ length: 7 }, (_, i) => (WEEK_START + i) % 7);

/** 日期選擇：跟下拉選單同一種按鈕，點開是月曆（Base UI Popover 裡一個 role="grid"，鍵盤操作照 WAI-ARIA 日期選擇） */
export function DatePicker(props: DatePickerProps) {
  const { value, min = null, max = null, marked = null } = props;
  const labelId = useId();
  const valueId = useId();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const today = dayOf(Date.now());
  const [focusKey, setFocusKey] = useState<DayKey>(value ?? today);
  const [y, m] = yearMonth(focusKey);
  const body = useRef<HTMLTableSectionElement>(null);
  const moveFocus = useRef(false);

  const selectable = (k: DayKey) => (!min || k >= min) && (!max || k <= max) && (!props.onlyMarked || !!marked?.has(k));
  const near = (dir: 1 | -1, from: DayKey) => stepDay(from, dir, selectable, min, max);
  const label = value ? (props.format ?? shortDay)(value, today) : (props.clearLabel ?? "選擇日期");

  /** 打開時焦點在目前的值；沒有值時在今天，只能選有資料的日子時改到最近一個有資料的日子 */
  const initialFocus = (): DayKey => {
    if (value) return value;
    const t = clampDay(today, min, max);
    if (selectable(t)) return t;
    return near(-1, t) ?? near(1, t) ?? t;
  };

  useEffect(() => {
    if (!open || !moveFocus.current) return;
    moveFocus.current = false;
    body.current?.querySelector<HTMLElement>(`td[data-key="${focusKey}"]`)?.focus();
  });

  const focusDay = (k: DayKey, move: boolean) => {
    moveFocus.current = move;
    setFocusKey(clampDay(k, min, max));
  };

  const pick = (k: DayKey | null) => {
    if (k && !selectable(k)) return;
    setOpen(false);
    if (k !== value) props.onChange(k);
  };

  const step = (dir: 1 | -1) => {
    const k = value && near(dir, value);
    if (k) props.onChange(k);
  };

  const firstOfView = makeDay(y, m, 1);
  const cells = monthGrid(y, m);
  const todayOk = selectable(today);

  return (
    <span
      className={`dp${props.stepper ? " dp-has-step" : ""}${props.className ? ` ${props.className}` : ""}`}
      role={props.stepper ? "group" : undefined}
      aria-labelledby={props.stepper ? labelId : undefined}
    >
      <span id={labelId} className="sr-only">
        {props.label}
      </span>
      {props.stepper ? (
        <button type="button" className="btn icon-only dp-step" aria-label="前一天" disabled={!value || near(-1, value) === null} onClick={() => step(-1)}>
          <Icon name="left" size={18} />
        </button>
      ) : null}
      <span className="sel">
        <Popover.Root
          open={open}
          onOpenChange={(next, details) => {
            if (next) {
              setInstant(details.event instanceof KeyboardEvent);
              setFocusKey(initialFocus());
            }
            setOpen(next);
          }}
        >
          <Popover.Trigger
            className="sel-trigger dp-trigger"
            aria-labelledby={`${labelId} ${valueId}`}
            data-placeholder={!value && !props.clearLabel ? "" : undefined}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" || open) return;
              e.preventDefault();
              setInstant(true);
              setFocusKey(initialFocus());
              setOpen(true);
            }}
          >
            <Icon name="calendar" size={17} />
            <span className="sel-value" id={valueId}>
              {label}
            </span>
            <span className="sel-chevron">
              <Icon name="down" size={16} />
            </span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Backdrop className="sheet-backdrop" data-sheet="popup" />
            <Popover.Positioner className="popup-pos" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
              <Popover.Popup
                className="popup dp-pop"
                aria-label={`選擇${props.label}`}
                data-instant={instant ? "" : undefined}
                // 打開時焦點放在目前的值（或今天）那一格
                initialFocus={() => body.current?.querySelector<HTMLElement>('td[tabindex="0"]') ?? null}
                // 頁面上的快速鍵（例如回放的方向鍵）不要收到日曆裡的按鍵
                onKeyDown={(e) => {
                  if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
                }}
              >
                <div className="popup-title" aria-hidden="true">
                  {props.label}
                </div>
                <div className="dp-head">
                  <button
                    type="button"
                    className="btn ghost icon-only dp-nav"
                    aria-label="上個月"
                    disabled={!!min && monthOf(addMonths(firstOfView, -1)) < monthOf(min)}
                    onClick={() => focusDay(addMonths(focusKey, -1), false)}
                  >
                    <Icon name="left" size={18} />
                  </button>
                  <h2 className="dp-title" id={titleId} aria-live="polite">
                    {monthTitle(y, m)}
                  </h2>
                  <button
                    type="button"
                    className="btn ghost icon-only dp-nav"
                    aria-label="下個月"
                    disabled={!!max && monthOf(addMonths(firstOfView, 1)) > monthOf(max)}
                    onClick={() => focusDay(addMonths(focusKey, 1), false)}
                  >
                    <Icon name="right" size={18} />
                  </button>
                </div>
                <table className="dp-grid" role="grid" aria-labelledby={titleId}>
                  <thead>
                    <tr>
                      {WEEK.map((d) => (
                        <th key={d} scope="col" abbr={WEEKDAY_LONG[d]}>
                          {WEEKDAY_SHORT[d]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody
                    ref={body}
                    onClick={(e) => {
                      const td = (e.target as Element).closest<HTMLElement>("td[data-key]");
                      if (td) pick(td.dataset.key as DayKey);
                    }}
                    onKeyDown={(e) => {
                      const td = (e.target as Element).closest<HTMLElement>("td[data-key]");
                      if (!td) return;
                      if (GRID_KEYS.has(e.key)) focusDay(moveInGrid(td.dataset.key as DayKey, e.key as GridKey, e.shiftKey), true);
                      else if (e.key === "Enter" || e.key === " ") pick(td.dataset.key as DayKey);
                      else return;
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    {Array.from({ length: 6 }, (_, r) => (
                      <tr key={r}>
                        {cells.slice(r * 7, r * 7 + 7).map((c) => {
                          const has = !!marked?.has(c.key);
                          return (
                            <td
                              key={c.key}
                              role="gridcell"
                              className="dp-day"
                              tabIndex={c.key === focusKey ? 0 : -1}
                              data-key={c.key}
                              aria-label={`${spokenDay(c.key)}${has && props.markedLabel ? `，${props.markedLabel}` : ""}${c.key === today ? "，今天" : ""}`}
                              aria-selected={c.key === value ? true : undefined}
                              aria-current={c.key === today ? "date" : undefined}
                              aria-disabled={selectable(c.key) ? undefined : true}
                              data-out={c.inMonth ? undefined : ""}
                              data-marked={has ? "" : undefined}
                            >
                              <span className="dp-num">{c.day}</span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {todayOk || props.clearLabel ? (
                  <div className="dp-foot">
                    {todayOk ? (
                      <button type="button" className="btn small" onClick={() => pick(today)}>
                        今天
                      </button>
                    ) : null}
                    {props.clearLabel ? (
                      <button type="button" className="btn small" aria-pressed={value === null} onClick={() => pick(null)}>
                        {props.clearLabel}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </span>
      {props.stepper ? (
        <button type="button" className="btn icon-only dp-step" aria-label="後一天" disabled={!value || near(1, value) === null} onClick={() => step(1)}>
          <Icon name="right" size={18} />
        </button>
      ) : null}
    </span>
  );
}
