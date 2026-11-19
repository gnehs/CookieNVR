import type { ObjectLabelsDto } from "../../src/api-types.ts";
import { COMMON_LABELS, labelName } from "../../src/objects/labels.ts";
import type { DetectConfig } from "../../src/types.ts";
import { api } from "../api.ts";
import { h, icon, segmented } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { settingRow } from "../ui/settings-row.ts";
import { labelGroups, labelsProblem, modeOf, OBJECT_MODES, objectSummary, posToScore, scoreToPos, STRICTNESS, strictnessOf } from "./object-model.ts";
import { slider } from "./slider.ts";

export type ObjectFields = Pick<DetectConfig, "labels" | "objectMode" | "objectScore">;

export interface ObjectSettingsUi {
  /** 放進偵測卡片的插入點 */
  el: HTMLElement;
  /** 目前的三個欄位，存檔時併進 detect */
  value(): ObjectFields;
  /** 系統設定有開、而且這台有開動作偵測才有這些選項；否則完全不出現，已存的值照舊保留 */
  setMotionOn(on: boolean): void;
  /** 卡片收合時的一句話；沒有開（或系統沒開）就是 null */
  summary(): string | null;
}

/** 類別目錄還沒到、或抓不到時的備用清單：只有常用類別 */
const FALLBACK: Pick<ObjectLabelsDto, "labels" | "common"> = { labels: COMMON_LABELS.map((key) => ({ key, zh: labelName(key), en: key })), common: [...COMMON_LABELS] };

/** 攝影機偵測卡片裡的「物件辨識」：模式、關注的類別、嚴格程度。onChange 在任何欄位變動、或系統是否開啟的答案回來時呼叫 */
export function objectSettings(ctx: PageCtx, saved: ObjectFields, onChange: () => void): ObjectSettingsUi {
  const d: ObjectFields = { labels: [...saved.labels], objectMode: saved.objectMode, objectScore: saved.objectScore };
  const labels = new Set(d.labels);
  let catalog: ObjectLabelsDto | null = null;
  let systemOn = false;
  let motionOn = true;

  const modeDesc = h("span");
  const modeRow = settingRow({
    title: "物件辨識",
    desc: modeDesc,
    wide: true,
    control: segmented("物件辨識", OBJECT_MODES.map(({ value, label }) => ({ value, label })), modeOf(d.objectMode), (v) => {
      d.objectMode = v;
      // 這台原本是「不辨識」時，生效的勾選是空的（後端不對外給）；切到標註或過濾就預設勾上人
      if (v !== "off" && labels.size === 0) {
        labels.add("person");
        sync();
        paintLabels();
      }
      refresh();
    }),
  });

  const commonBox = h("div", { class: "obj-labels", role: "group", "aria-label": "要注意的東西" });
  const moreBox = h("div", { class: "obj-labels", role: "group", "aria-label": "更多類別" });
  const moreTitle = h("span");
  const more = h("details", { class: "detect-more obj-more", hidden: true }, h("summary", null, icon("chevron", 15), moreTitle), h("div", { class: "detect-more-body" }, moreBox));
  const note = h("small", { class: "hint", hidden: true });
  const problem = h("p", { class: "callout warn", role: "status", hidden: true }, icon("alert"), h("span"));
  const labelBlock = h("div", { class: "set-block obj-block" }, h("span", { class: "set-row-title" }, "要注意的東西"), commonBox, more, note, problem);

  const sync = () => {
    d.labels = [...labels];
  };
  const moreTitleText = (n: number) => (n > 0 ? `更多類別（已選 ${n}）` : "更多類別");
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

  const word = h("span", { class: "range-value" });
  const hint = h("small", { class: "hint" });
  const range = slider("嚴格程度", scoreToPos(d.objectScore), (pos) => {
    d.objectScore = posToScore(pos);
    refresh();
  });
  range.step = String(100 / 13);
  const strictBlock = h(
    "div",
    { class: "set-block obj-block" },
    h(
      "div",
      { class: "range-field" },
      h("div", { class: "range-label" }, h("span", null, "嚴格程度"), word),
      h("div", { class: "range-row" }, h("span", { class: "range-end" }, "寬鬆"), range, h("span", { class: "range-end" }, "嚴格")),
      hint,
    ),
  );

  const el = h("div", { class: "set-rows obj-section", hidden: true }, modeRow, labelBlock, strictBlock);

  function refresh(notify = true) {
    const mode = modeOf(d.objectMode);
    el.hidden = !(systemOn && motionOn);
    modeDesc.textContent = OBJECT_MODES.find((m) => m.value === mode)!.desc;
    labelBlock.hidden = mode === "off";
    strictBlock.hidden = mode === "off";
    const msg = labelsProblem(mode, d.labels);
    problem.hidden = !msg;
    problem.lastElementChild!.textContent = msg ?? "";
    const s = STRICTNESS[strictnessOf(d.objectScore)];
    word.textContent = s.word;
    hint.textContent = s.hint;
    range.setAttribute("aria-valuetext", s.word);
    if (notify) onChange();
  }
  refresh(false);

  void api.settings().then(
    (s) => {
      if (!ctx.isCurrent()) return;
      systemOn = s.objects.enabled;
      refresh();
      if (systemOn)
        void api.objectLabels().then(
          (c) => {
            if (!ctx.isCurrent()) return;
            catalog = c;
            paintLabels();
          },
          () => {},
        );
    },
    () => {},
  );

  return {
    el,
    value: () => ({ labels: [...d.labels], objectMode: d.objectMode, objectScore: d.objectScore }),
    setMotionOn(on) {
      if (on === motionOn) return;
      motionOn = on;
      el.hidden = !(systemOn && motionOn);
    },
    summary: () => (systemOn && motionOn ? objectSummary(modeOf(d.objectMode), d.labels) : null),
  };
}
