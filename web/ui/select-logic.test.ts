import { describe, expect, test } from "bun:test";
import { CLOSED, keepActive, NO_TYPEAHEAD, openAt, selectKey, TYPEAHEAD_MS, typeahead, type ListState, type NavItem, type Typeahead } from "./select-logic.ts";

const items: NavItem[] = [
  { label: "所有攝影機" },
  { label: "Back yard" },
  { label: "Garage", disabled: true },
  { label: "Garden" },
  { label: "Gate" },
  { label: "Front door" },
];

/** 依序按下一串鍵，回傳最後的狀態與過程中選取的索引 */
function press(keys: string[], start: ListState = CLOSED, selected = 0, t0 = 1000, gap = 50) {
  let state = start;
  let ta: Typeahead = NO_TYPEAHEAD;
  const commits: number[] = [];
  let restored = false;
  keys.forEach((key, i) => {
    const r = selectKey(state, ta, items, selected, { key, now: t0 + i * gap });
    state = r.state;
    ta = r.typeahead;
    if (r.commit !== null) {
      commits.push(r.commit);
      selected = r.commit;
    }
    restored ||= r.restoreFocus;
  });
  return { state, commits, restored };
}

describe("開啟", () => {
  test("打開時反白目前的值；目前的值被停用時反白第一個可選的", () => {
    expect(openAt(items, 4)).toEqual({ open: true, active: 4 });
    expect(openAt(items, 2)).toEqual({ open: true, active: 0 });
    expect(openAt([{ label: "a", disabled: true }], 0)).toEqual(CLOSED);
  });

  test("關著時方向鍵、Enter、空白鍵打開並停在目前的值，Home／End 停在頭尾", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", " "]) expect(press([k], CLOSED, 3).state).toEqual({ open: true, active: 3 });
    expect(press(["End"], CLOSED, 0).state).toEqual({ open: true, active: 5 });
    expect(press(["Home"], CLOSED, 4).state).toEqual({ open: true, active: 0 });
  });

  test("關著時其他按鍵不處理，交給頁面", () => {
    const r = selectKey(CLOSED, NO_TYPEAHEAD, items, 0, { key: "ArrowLeft", now: 0 });
    expect(r.handled).toBe(false);
    expect(selectKey(CLOSED, NO_TYPEAHEAD, items, 0, { key: "a", now: 0, mod: true }).handled).toBe(false);
  });
});

describe("清單裡的方向鍵", () => {
  test("上下移動會跳過停用的項目，到頭不繞回", () => {
    expect(press(["ArrowDown", "ArrowDown"], { open: true, active: 1 }).state).toEqual({ open: true, active: 4 });
    expect(press(["ArrowUp"], { open: true, active: 3 }).state).toEqual({ open: true, active: 1 });
    expect(press(["ArrowDown", "ArrowDown"], { open: true, active: 5 }).state).toEqual({ open: true, active: 5 });
    expect(press(["ArrowUp"], { open: true, active: 0 }).state).toEqual({ open: true, active: 0 });
  });

  test("Home／End 到第一個與最後一個可選的；PageUp／PageDown 一次十個並停在邊界", () => {
    const last = [...items, { label: "z", disabled: true }];
    const r = selectKey({ open: true, active: 1 }, NO_TYPEAHEAD, last, 0, { key: "End", now: 0 });
    expect(r.state).toEqual({ open: true, active: 5 });
    expect(press(["Home"], { open: true, active: 4 }).state).toEqual({ open: true, active: 0 });
    expect(press(["PageDown"], { open: true, active: 0 }).state).toEqual({ open: true, active: 5 });
    expect(press(["PageUp"], { open: true, active: 5 }).state).toEqual({ open: true, active: 0 });
  });
});

describe("選取與關閉", () => {
  test("Enter 與空白鍵選取反白的項目、關閉並把焦點還給按鈕", () => {
    for (const k of ["Enter", " "]) {
      const r = press(["ArrowDown", k], { open: true, active: 0 });
      expect(r.commits).toEqual([1]);
      expect(r.state).toEqual(CLOSED);
      expect(r.restored).toBe(true);
    }
  });

  test("Alt+↑ 選取並關閉", () => {
    const r = selectKey({ open: true, active: 3 }, NO_TYPEAHEAD, items, 0, { key: "ArrowUp", alt: true, now: 0 });
    expect(r.commit).toBe(3);
    expect(r.state).toEqual(CLOSED);
  });

  test("Esc 關閉不改值，焦點回到按鈕", () => {
    const r = press(["ArrowDown", "ArrowDown", "Escape"], { open: true, active: 0 });
    expect(r.commits).toEqual([]);
    expect(r.restored).toBe(true);
    expect(r.state).toEqual(CLOSED);
  });

  test("Tab 關閉但不吃掉按鍵，焦點照常移到下一個欄位", () => {
    const r = selectKey({ open: true, active: 3 }, NO_TYPEAHEAD, items, 0, { key: "Tab", now: 0 });
    expect(r.state).toEqual(CLOSED);
    expect(r.commit).toBeNull();
    expect(r.handled).toBe(false);
  });
});

describe("輸入字母跳到項目", () => {
  test("連續輸入比對開頭，不分大小寫，跳過停用的項目", () => {
    expect(press(["g", "a", "t"], { open: true, active: 0 }).state).toEqual({ open: true, active: 4 });
    expect(press(["F"], { open: true, active: 0 }).state).toEqual({ open: true, active: 5 });
  });

  test("一直按同一個字母時在以它開頭的項目之間輪流", () => {
    const seen = [1, 2, 3, 4].map((n) => press(Array(n).fill("g"), { open: true, active: 0 }).state);
    expect(seen.map((s) => (s.open ? s.active : -1))).toEqual([3, 4, 3, 4]);
  });

  test("停頓超過時限後重新開始比對", () => {
    let ta = typeahead(items, NO_TYPEAHEAD, "g", 0, 0).typeahead;
    const r = typeahead(items, ta, "b", TYPEAHEAD_MS + 1, 3);
    expect(r.index).toBe(1);
    expect(r.typeahead.query).toBe("b");
    ta = typeahead(items, NO_TYPEAHEAD, "b", 0, 0).typeahead;
    expect(typeahead(items, ta, "a", 10, 1).index).toBe(1);
  });

  test("輸入中按空白鍵是字串的一部分，不會選取", () => {
    const r = press(["b", "a", "c", "k", " ", "y"], { open: true, active: 0 });
    expect(r.commits).toEqual([]);
    expect(r.state).toEqual({ open: true, active: 1 });
  });

  test("關著時打字會打開並反白符合的項目；沒有符合的就停在目前的值", () => {
    expect(press(["f"], CLOSED, 0).state).toEqual({ open: true, active: 5 });
    expect(press(["x"], CLOSED, 3).state).toEqual({ open: true, active: 3 });
  });
});

describe("輪詢更新選項", () => {
  const v = (labels: string[], disabled: string[] = []) => labels.map((l) => ({ value: l, label: l, disabled: disabled.includes(l) }));
  test("反白留在同一個值上，即使它換了位置", () => {
    expect(keepActive(["a", "b", "c"], v(["x", "a", "b", "c"]), { open: true, active: 2 })).toEqual({ open: true, active: 3 });
  });
  test("反白的值不見了就停在原本的位置附近；全部不能選時關閉", () => {
    expect(keepActive(["a", "b", "c"], v(["a", "c"]), { open: true, active: 1 })).toEqual({ open: true, active: 1 });
    expect(keepActive(["a", "b", "c"], v(["a", "b"]), { open: true, active: 2 })).toEqual({ open: true, active: 1 });
    expect(keepActive(["a"], v(["a"], ["a"]), { open: true, active: 0 })).toEqual(CLOSED);
    expect(keepActive(["a"], v(["b"]), CLOSED)).toEqual(CLOSED);
  });
});
