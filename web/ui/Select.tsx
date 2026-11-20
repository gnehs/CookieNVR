import { Select as Base } from "@base-ui/react/select";
import { useId, useState } from "react";
import { Icon } from "./Icon.tsx";
import { useSheetSwipe } from "./sheet-swipe.ts";
import { SHEET_POPUP } from "./useMedia.ts";
import type { IconName } from "./icons.ts";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  icon?: IconName;
  /** 項目下方的次要說明 */
  desc?: string;
  disabled?: boolean;
}

export interface SelectGroup<V extends string> {
  heading: string;
  options: SelectOption<V>[];
}

export type SelectEntry<V extends string> = SelectOption<V> | SelectGroup<V> | "separator";

export interface SelectProps<V extends string> {
  /** 給螢幕閱讀器的名稱，也是手機底部面板的標題 */
  label: string;
  entries: SelectEntry<V>[];
  value: V | null;
  onChange: (value: V) => void;
  /** 按鈕裡值前面的圖示 */
  icon?: IconName;
  /** 沒有值時按鈕上的字 */
  placeholder?: string;
  /** 按鈕上顯示的字；預設是選項的 label（例如倍速只顯示「2×」） */
  display?: (o: SelectOption<V>) => string;
  /** 放在表單裡時，用這個名稱帶出目前的值 */
  name?: string;
  /** quiet：播放器控制列上的無框樣式 */
  variant?: "quiet";
  className?: string;
  disabled?: boolean;
  /** 設定列的標題 `<label htmlFor>` 用；說明文字用 aria-describedby */
  id?: string;
  "aria-describedby"?: string;
}

const isGroup = <V extends string>(e: SelectEntry<V>): e is SelectGroup<V> => typeof e === "object" && "heading" in e;
const flatten = <V extends string>(entries: SelectEntry<V>[]) => entries.flatMap((e) => (e === "separator" ? [] : isGroup(e) ? e.options : [e]));

function item<V extends string>(o: SelectOption<V>) {
  return (
    <Base.Item key={o.value} value={o.value} disabled={o.disabled} className="sel-opt" label={o.label}>
      {o.icon ? <Icon name={o.icon} size={17} /> : null}
      <span className="sel-opt-text">
        <Base.ItemText render={<span />}>{o.label}</Base.ItemText>
        {o.desc ? <small>{o.desc}</small> : null}
      </span>
      <Base.ItemIndicator keepMounted className="sel-check">
        <Icon name="check" size={16} />
      </Base.ItemIndicator>
    </Base.Item>
  );
}

function List<V extends string>({ entries }: { entries: SelectEntry<V>[] }) {
  return (
    <Base.List>
      {entries.map((e, i) => {
        if (e === "separator") return <Base.Separator key={`sep${i}`} className="sel-sep" />;
        if (!isGroup(e)) return item(e);
        return (
          <Base.Group key={`g${e.heading}`} className="sel-group">
            <Base.GroupLabel className="sel-heading">{e.heading}</Base.GroupLabel>
            {e.options.map(item)}
          </Base.Group>
        );
      })}
    </Base.List>
  );
}

function Pop<V extends string>({ label, entries, instant, onDismiss }: { label: string; entries: SelectEntry<V>[]; instant: boolean; onDismiss: () => void }) {
  const swipe = useSheetSwipe(SHEET_POPUP, onDismiss);
  return (
    <Base.Portal>
      <Base.Backdrop className="sheet-backdrop" data-sheet="popup" />
      <Base.Positioner className="popup-pos" alignItemWithTrigger={false} side="bottom" align="start" sideOffset={6} collisionPadding={8}>
        <Base.Popup ref={swipe} className="popup sel-pop" data-instant={instant ? "" : undefined}>
          <div className="popup-title" aria-hidden="true">
            {label}
          </div>
          <List entries={entries} />
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}

/**
 * 下拉選單：Base UI Select，外觀沿用 `ui/select.css` 與 `ui/popup.css`。
 * 桌面是對齊按鈕的浮動清單，手機（窄螢幕或橫拿）由 CSS 改成底部面板。
 */
export function Select<V extends string>(props: SelectProps<V>) {
  const { label, entries, value, onChange } = props;
  const labelId = useId();
  const valueId = useId();
  // 鍵盤打開的不播動畫：常用的操作要立刻出現
  const [instant, setInstant] = useState(false);
  const [open, setOpen] = useState(false);
  const options = flatten(entries);
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <span className="sel">
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <Base.Root
        value={value}
        onValueChange={(v) => {
          if (v !== null && v !== value) onChange(v as V);
        }}
        open={open}
        onOpenChange={(next, details) => {
          if (next) setInstant(details.event instanceof KeyboardEvent);
          setOpen(next);
        }}
        name={props.name}
        disabled={props.disabled}
      >
        <Base.Trigger
          id={props.id}
          className={`sel-trigger${props.variant === "quiet" ? " quiet" : ""}${props.className ? ` ${props.className}` : ""}`}
          // 名稱念「攝影機」，值念目前選到的「客廳」
          aria-labelledby={`${labelId} ${valueId}`}
          aria-describedby={props["aria-describedby"]}
          data-placeholder={selected ? undefined : ""}
        >
          {props.icon ? <Icon name={props.icon} size={17} /> : null}
          <span className="sel-value" id={valueId}>
            {selected ? (props.display?.(selected) ?? selected.label) : (props.placeholder ?? "")}
          </span>
          <span className="sel-chevron">
            <Icon name="down" size={16} />
          </span>
        </Base.Trigger>
        <Pop label={label} entries={entries} instant={instant} onDismiss={() => setOpen(false)} />
      </Base.Root>
    </span>
  );
}

export interface MultiSelectProps<V extends string> {
  /** 給螢幕閱讀器的名稱，也是手機底部面板的標題 */
  label: string;
  entries: SelectEntry<V>[];
  value: V[];
  onChange: (value: V[]) => void;
  /** 按鈕上顯示的字，由呼叫端依目前勾選的項目決定（「所有類別」「人、汽車」） */
  summary: string;
  icon?: IconName;
  className?: string;
  disabled?: boolean;
}

/** 可勾選多個的下拉選單：外觀與 Select 相同，點選項目切換勾選，清單不會自動關閉 */
export function MultiSelect<V extends string>(props: MultiSelectProps<V>) {
  const { label, entries, value, onChange } = props;
  const labelId = useId();
  const valueId = useId();
  const [instant, setInstant] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <span className="sel">
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <Base.Root
        multiple
        value={value}
        onValueChange={(v) => onChange(v as V[])}
        open={open}
        onOpenChange={(next, details) => {
          if (next) setInstant(details.event instanceof KeyboardEvent);
          setOpen(next);
        }}
        disabled={props.disabled}
      >
        <Base.Trigger className={`sel-trigger${props.className ? ` ${props.className}` : ""}`} aria-labelledby={`${labelId} ${valueId}`}>
          {props.icon ? <Icon name={props.icon} size={17} /> : null}
          <span className="sel-value" id={valueId}>
            {props.summary}
          </span>
          <span className="sel-chevron">
            <Icon name="down" size={16} />
          </span>
        </Base.Trigger>
        <Pop label={label} entries={entries} instant={instant} onDismiss={() => setOpen(false)} />
      </Base.Root>
    </span>
  );
}
