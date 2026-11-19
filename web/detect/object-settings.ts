import type { ObjectLabelsDto } from "../../src/api-types.ts";
import { COMMON_LABELS, labelName } from "../../src/objects/labels.ts";
import type { DetectConfig } from "../../src/types.ts";
import { h, icon, tiles } from "../dom.ts";
import { labelGroups, labelsProblem, modeOf, OBJECT_MODES, posToScore, scoreToPos, STRICTNESS, strictnessOf } from "./object-model.ts";
import { slider } from "./slider.ts";

export interface ObjectSettingsUi {
  el: HTMLElement;
  /** 系統設定有開物件辨識才顯示；沒開時這些選項完全不出現，已存的值照舊保留 */
  setAvailable(available: boolean): void;
  /** 目前模型的類別目錄；還沒拿到之前先列常用類別 */
  setCatalog(catalog: ObjectLabelsDto | null): void;
}

/** 類別目錄還沒到、或抓不到時的備用清單：只有常用類別 */
const FALLBACK: Pick<ObjectLabelsDto, "labels" | "common"> = { labels: COMMON_LABELS.map((key) => ({ key, zh: labelName(key), en: key })), common: [...COMMON_LABELS] };

/** 攝影機偵測設定裡的「物件辨識」：模式、關注的類別、嚴格程度。直接改傳入的 detect 設定 */
export function objectSettings(d: DetectConfig): ObjectSettingsUi {
  const labels = new Set(d.labels);
  let catalog: ObjectLabelsDto | null = null;

  const modeTiles = tiles("物件辨識", OBJECT_MODES, modeOf(d.objectMode), (v) => {
    d.objectMode = v;
    // 這台原本是「不辨識」時，生效的勾選是空的（後端不對外給）；切到標註或過濾就預設勾上人
    if (v !== "off" && labels.size === 0) {
      labels.add("person");
      sync();
      paintLabels();
    }
    refresh();
  });
  modeTiles.classList.add("obj-modes");

  const commonBox = h("div", { class: "obj-labels", role: "group", "aria-label": "要注意的東西" });
  const moreBox = h("div", { class: "obj-labels", role: "group", "aria-label": "更多類別" });
  const moreTitle = h("span");
  const more = h("details", { class: "detect-more obj-more", hidden: true }, h("summary", null, icon("chevron", 15), moreTitle), h("div", { class: "detect-more-body" }, moreBox));
  const note = h("small", { class: "hint", hidden: true });
  const sync = () => {
    d.labels = [...labels];
  };
  const box = (key: string, zh: string) => {
    const input = h("input", { type: "checkbox", value: key, checked: labels.has(key) });
    input.addEventListener("change", () => {
      if (input.checked) labels.add(key);
      else labels.delete(key);
      sync();
      moreTitle.textContent = moreTitleText(more.querySelectorAll("input:checked").length);
      refresh();
    });
    return h("label", { class: "obj-label" }, input, h("span", null, icon("check", 15), zh));
  };
  const moreTitleText = (n: number) => (n > 0 ? `更多類別（已選 ${n}）` : "更多類別");
  function paintLabels() {
    const g = labelGroups(catalog ?? FALLBACK, [...labels]);
    commonBox.replaceChildren(...g.common.map((l) => box(l.key, l.zh)));
    moreBox.replaceChildren(...g.more.map((l) => box(l.key, l.zh)));
    more.hidden = g.more.length === 0;
    if (g.moreHasSelected && !more.dataset.touched) more.open = true;
    moreTitle.textContent = moreTitleText(g.more.filter((l) => labels.has(l.key)).length);
    const text = !catalog ? null : !catalog.known ? "自訂模型還沒載入過，類別清單暫時是內建模型的，載入後會更新。" : g.noPackage ? (catalog.model === "builtin" ? "內建模型不含包裹；要辨識包裹需要放入含有這個類別的自訂模型。" : "目前的模型沒有包裹這個類別。") : null;
    note.hidden = !text;
    note.textContent = text;
  }
  more.addEventListener("toggle", () => (more.dataset.touched = "1"));
  paintLabels();

  const problem = h("p", { class: "callout warn", role: "status", hidden: true }, icon("alert"), h("span"));
  const labelField = h(
    "div",
    { class: "field" },
    h("span", { class: "legend" }, "要注意的東西"),
    commonBox,
    more,
    note,
    problem,
  );

  const word = h("span", { class: "range-value" });
  const hint = h("small", { class: "hint" });
  const range = slider("嚴格程度", scoreToPos(d.objectScore), (pos) => {
    d.objectScore = posToScore(pos);
    refresh();
  });
  range.step = String(100 / 13);
  const strictField = h(
    "div",
    { class: "range-field" },
    h("div", { class: "range-label" }, h("span", null, "嚴格程度"), word),
    h("div", { class: "range-row" }, h("span", { class: "range-end" }, "寬鬆"), range, h("span", { class: "range-end" }, "嚴格")),
    hint,
  );

  const detail = h("div", { class: "form" }, labelField, strictField);
  const el = h(
    "div",
    { class: "obj-section", hidden: true },
    h("div", { class: "field" }, h("span", { class: "legend" }, "物件辨識"), modeTiles),
    detail,
  );

  function refresh() {
    const mode = modeOf(d.objectMode);
    detail.hidden = mode === "off";
    const msg = labelsProblem(mode, d.labels);
    problem.hidden = !msg;
    problem.lastElementChild!.textContent = msg ?? "";
    const s = STRICTNESS[strictnessOf(d.objectScore)];
    word.textContent = s.word;
    hint.textContent = s.hint;
    range.setAttribute("aria-valuetext", s.word);
  }
  refresh();

  return {
    el,
    setAvailable(available) {
      el.hidden = !available;
    },
    setCatalog(next) {
      catalog = next;
      paintLabels();
    },
  };
}
