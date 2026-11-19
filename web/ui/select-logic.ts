/**
 * 下拉選單的互動邏輯，不碰 DOM：開關狀態、目前反白的項目、輸入字母跳到項目。
 * 行為照 WAI-ARIA 的 select-only combobox：清單開著時方向鍵不繞回、Enter／空白鍵選取、Esc 不改值、Tab 關閉。
 */
export interface NavItem {
  label: string;
  disabled?: boolean;
}

export type ListState = { open: false } | { open: true; active: number };

/** 連續輸入的字串；停頓超過 TYPEAHEAD_MS 就重新開始 */
export interface Typeahead {
  query: string;
  at: number;
}

export const TYPEAHEAD_MS = 600;
export const PAGE_STEP = 10;
export const CLOSED: ListState = { open: false };
export const NO_TYPEAHEAD: Typeahead = { query: "", at: -Infinity };

export interface KeyInput {
  key: string;
  now: number;
  alt?: boolean;
  /** Ctrl／Cmd 組合鍵交給瀏覽器 */
  mod?: boolean;
}

export interface KeyResult {
  state: ListState;
  typeahead: Typeahead;
  /** 要選取的項目索引 */
  commit: number | null;
  /** 關閉後把焦點還給觸發按鈕 */
  restoreFocus: boolean;
  /** 這個按鍵被選單用掉了，呼叫端要 preventDefault */
  handled: boolean;
}

const enabled = (items: readonly NavItem[], i: number) => i >= 0 && i < items.length && !items[i]!.disabled;

/** 從 from 往 dir 方向找第一個可選的項目（包含 from 本身）；找不到回傳 -1 */
export function seek(items: readonly NavItem[], from: number, dir: 1 | -1): number {
  for (let i = from; i >= 0 && i < items.length; i += dir) if (enabled(items, i)) return i;
  return -1;
}

export const firstEnabled = (items: readonly NavItem[]) => seek(items, 0, 1);
export const lastEnabled = (items: readonly NavItem[]) => seek(items, items.length - 1, -1);

/** 打開時反白目前選中的項目；沒有選中或選中的被停用時反白第一個可選的 */
export function openAt(items: readonly NavItem[], selected: number): ListState {
  const active = enabled(items, selected) ? selected : firstEnabled(items);
  return active < 0 ? CLOSED : { open: true, active };
}

/** 移動 n 格，停在可選的項目上；到頭就停住，不繞回 */
function move(items: readonly NavItem[], from: number, n: number): number {
  const dir = n > 0 ? 1 : -1;
  const target = Math.max(0, Math.min(items.length - 1, from + n));
  const hit = seek(items, target, dir === 1 ? -1 : 1);
  // 目標附近往回找到的項目比原本還退後時，改往前找
  if (hit >= 0 && (dir === 1 ? hit > from : hit < from)) return hit;
  const ahead = seek(items, target, dir);
  return ahead >= 0 ? ahead : from;
}

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * 輸入字母找項目：連續打的字串比對開頭；一直按同一個字母會在以它開頭的項目之間輪流。
 * 從 current 的下一個開始找，找到結尾再從頭找。
 */
export function typeahead(items: readonly NavItem[], ta: Typeahead, char: string, now: number, current: number): { typeahead: Typeahead; index: number } {
  const query = now - ta.at > TYPEAHEAD_MS ? char : ta.query + char;
  const next = { query, at: now };
  const q = norm(query);
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeated ? q[0]! : q;
  // 打第一個字或同一個字輪流時，從下一個開始找；字串越打越長時留在目前這個也算
  const startAt = query.length === 1 || repeated ? current + 1 : Math.max(current, 0);
  const n = items.length;
  for (let k = 0; k < n; k++) {
    const i = (((startAt + k) % n) + n) % n;
    if (enabled(items, i) && norm(items[i]!.label).startsWith(needle)) return { typeahead: next, index: i };
  }
  return { typeahead: next, index: -1 };
}

const isChar = (key: string) => [...key].length === 1 && key !== " ";

/** 清單開著與關著時的按鍵；selected 是目前的值在 items 裡的索引（沒有則為 -1） */
export function selectKey(state: ListState, ta: Typeahead, items: readonly NavItem[], selected: number, input: KeyInput): KeyResult {
  const out = (s: ListState, opts: Partial<KeyResult> = {}): KeyResult => ({ state: s, typeahead: ta, commit: null, restoreFocus: false, handled: true, ...opts });
  const ignore: KeyResult = { state, typeahead: ta, commit: null, restoreFocus: false, handled: false };
  if (input.mod) return ignore;
  const { key } = input;
  const typing = input.now - ta.at <= TYPEAHEAD_MS && ta.query !== "";

  if (!state.open) {
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") return out(openAt(items, selected), { typeahead: NO_TYPEAHEAD });
    if (key === "Home") return out(openAt(items, firstEnabled(items)));
    if (key === "End") return out(openAt(items, lastEnabled(items)));
    if (isChar(key)) {
      const r = typeahead(items, ta, key, input.now, selected);
      return out(r.index >= 0 ? { open: true, active: r.index } : openAt(items, selected), { typeahead: r.typeahead });
    }
    return ignore;
  }

  const a = state.active;
  switch (key) {
    case "ArrowDown":
      return out({ open: true, active: move(items, a, 1) });
    case "ArrowUp":
      if (input.alt) return out(CLOSED, { commit: a, restoreFocus: true });
      return out({ open: true, active: move(items, a, -1) });
    case "Home":
      return out({ open: true, active: firstEnabled(items) });
    case "End":
      return out({ open: true, active: lastEnabled(items) });
    case "PageDown":
      return out({ open: true, active: move(items, a, PAGE_STEP) });
    case "PageUp":
      return out({ open: true, active: move(items, a, -PAGE_STEP) });
    case "Enter":
      return out(CLOSED, { commit: a, restoreFocus: true, typeahead: NO_TYPEAHEAD });
    case "Escape":
      return out(CLOSED, { restoreFocus: true, typeahead: NO_TYPEAHEAD });
    case "Tab":
      // Tab 照常移到下一個欄位，只是順便關掉清單
      return { ...out(CLOSED, { typeahead: NO_TYPEAHEAD }), handled: false };
    case " ":
      if (typing) {
        const r = typeahead(items, ta, " ", input.now, a);
        return out({ open: true, active: r.index >= 0 ? r.index : a }, { typeahead: r.typeahead });
      }
      return out(CLOSED, { commit: a, restoreFocus: true });
  }
  if (isChar(key)) {
    const r = typeahead(items, ta, key, input.now, a);
    return out({ open: true, active: r.index >= 0 ? r.index : a }, { typeahead: r.typeahead });
  }
  return ignore;
}

/** 選項換了以後，讓反白留在同一個值上；那個值不見了就停在原本的位置附近 */
export function keepActive(prevValues: readonly string[], nextItems: readonly (NavItem & { value: string })[], state: ListState): ListState {
  if (!state.open) return state;
  const v = prevValues[state.active];
  const same = nextItems.findIndex((it) => it.value === v);
  if (same >= 0 && !nextItems[same]!.disabled) return { open: true, active: same };
  const near = Math.min(state.active, nextItems.length - 1);
  const i = seek(nextItems, near, 1) >= 0 ? seek(nextItems, near, 1) : seek(nextItems, near, -1);
  return i < 0 ? CLOSED : { open: true, active: i };
}
