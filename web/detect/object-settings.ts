import { OBJECT_LABELS } from "../../src/objects/labels.ts";
import type { DetectConfig } from "../../src/types.ts";
import { h, icon, tiles } from "../dom.ts";
import { labelsProblem, modeOf, OBJECT_MODES, posToScore, scoreToPos, STRICTNESS, strictnessOf } from "./object-model.ts";
import { slider } from "./slider.ts";

export interface ObjectSettingsUi {
  el: HTMLElement;
  /** 系統設定有開物件辨識才顯示；沒開時這些選項完全不出現，已存的值照舊保留 */
  setAvailable(available: boolean): void;
}

/** 攝影機偵測設定裡的「物件辨識」：模式、關注的類別、嚴格程度。直接改傳入的 detect 設定 */
export function objectSettings(d: DetectConfig): ObjectSettingsUi {
  const labels = new Set(d.labels);
  const entries = Object.entries(OBJECT_LABELS) as [string, string][];

  const modeTiles = tiles("物件辨識", OBJECT_MODES, modeOf(d.objectMode), (v) => {
    d.objectMode = v;
    refresh();
  });
  modeTiles.classList.add("obj-modes");

  const boxes = entries.map(([value, text]) => {
    const input = h("input", { type: "checkbox", value, checked: labels.has(value) });
    input.addEventListener("change", () => {
      if (input.checked) labels.add(value);
      else labels.delete(value);
      d.labels = entries.map(([k]) => k).filter((k) => labels.has(k));
      refresh();
    });
    return { input, el: h("label", { class: "obj-label" }, input, h("span", null, icon("check", 15), text)) };
  });
  const problem = h("p", { class: "callout warn", role: "status", hidden: true }, icon("alert"), h("span"));
  const labelField = h(
    "div",
    { class: "field" },
    h("span", { class: "legend" }, "要注意的東西"),
    h("div", { class: "obj-labels", role: "group", "aria-label": "要注意的東西" }, boxes.map((b) => b.el)),
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
  };
}
