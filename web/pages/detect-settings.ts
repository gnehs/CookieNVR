import type { CameraDto } from "../../src/api-types.ts";
import { DEFAULT_DETECT, detectConfigOf, SENSITIVITY_PRESETS } from "../../src/detect/config.ts";
import type { DetectConfig, DetectSource } from "../../src/types.ts";
import { api } from "../api.ts";
import { choice, h, icon, nextId, panelSection, segmented, switchInput, switchRow } from "../dom.ts";
import { maskEditor } from "../detect/mask-editor.ts";
import { areaToPos, formatArea, posToArea, posToThreshold, sensitivityOf, thresholdToPos, type Sensitivity } from "../detect/model.ts";
import { scoreMeter, type ScoreMeter } from "../detect/score-meter.ts";
import type { PageCtx } from "../router.ts";

const SNAPSHOT_MS = 2_000;

const SOURCES: { value: DetectSource; label: string; hint: string }[] = [
  { value: "pixel", label: "畫面變化", hint: "比對畫面的變化，每台攝影機都能用，也能排除不需要的區域。" },
  { value: "onvif", label: "相機偵測", hint: "用相機內建的偵測，不佔用這台電腦的資源，但不能排除區域。" },
  { value: "both", label: "兩者都用", hint: "任一個偵測到就算，比較不會漏掉。" },
];

const SENSITIVITY: { value: Sensitivity; label: string }[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "custom", label: "自訂" },
];

const SENSITIVITY_HINT: Record<Sensitivity, string> = {
  low: "只有明顯的動作才算，適合樹多、車多或光線常變的地方。",
  medium: "大多數情況的建議值。",
  high: "細微的變化也會偵測到，適合室內或想要不漏接。",
  custom: "往右越靈敏。",
};

/** 自訂靈敏度的文字描述，不顯示數字 */
function sensitivityWord(threshold: number): string {
  if (threshold <= SENSITIVITY_PRESETS.high) return "很靈敏";
  if (threshold <= SENSITIVITY_PRESETS.medium) return "偏靈敏";
  if (threshold <= SENSITIVITY_PRESETS.low) return "偏保守";
  return "很保守";
}

function slider(label: string, pos: number, onInput: (pos: number) => void) {
  const input = h("input", { type: "range", class: "range", min: "0", max: "100", step: "0.5", "aria-label": label });
  input.value = String(pos);
  const sync = () => input.style.setProperty("--fill", `${input.value}%`);
  input.addEventListener("input", () => {
    sync();
    onInput(Number(input.value));
  });
  sync();
  return input;
}

const sameMasks = (a: DetectConfig["masks"], b: DetectConfig["masks"]) => JSON.stringify(a) === JSON.stringify(b);

export interface DetectSettings {
  el: HTMLElement;
  value(): DetectConfig;
  /** 表單上這台目前有沒有 ONVIF（Tapo 一定有；通用 RTSP 要開「使用 ONVIF」） */
  setOnvif(available: boolean): void;
}

/** 攝影機表單裡的「動作偵測」區塊。camera 為 null 是新增中的攝影機，還沒有畫面可看 */
export function detectSettings(ctx: PageCtx, camera: CameraDto | null): DetectSettings {
  const saved = camera ? detectConfigOf(camera.config) : DEFAULT_DETECT;
  const d: DetectConfig = { ...saved, masks: saved.masks.map((m) => ({ points: m.points.map(([x, y]) => [x, y]) })) };
  let onvif = true;
  const live = camera !== null && camera.config.enabled;

  // ---------- 開關與來源 ----------
  const enabled = switchRow(
    switchInput(d.enabled, (v) => {
      d.enabled = v;
      refresh();
    }),
    "偵測動作",
    "有動靜時建立事件，之後可以在「事件」頁快速找到。",
  );
  const sourceHint = h("small", { class: "hint" });
  const onvifWarn = h("p", { class: "callout warn" }, icon("alert"), h("span"));
  const source = h(
    "div",
    { class: "field" },
    h("span", { class: "legend" }, "偵測方式"),
    segmented("偵測方式", SOURCES.map(({ value, label }) => ({ value, label })), d.source, (v) => {
      d.source = v;
      refresh();
    }),
    sourceHint,
    onvifWarn,
  );

  // ---------- 畫面、遮罩與即時變化 ----------
  let meter: ScoreMeter | null = null;
  const editor = maskEditor(d.masks, (masks) => {
    d.masks = masks;
    refresh();
  });
  const ptzNote = h("p", { class: "detect-ptz hint", hidden: true }, icon("info", 15), h("span", null, "排除區域是照畫面位置畫的。鏡頭轉到別的方向後會對不上，轉回原位就恢復；如果要長期換角度，記得重畫。"));
  const meterSlot = h("div", { class: "detect-meter-slot" });
  const preview = live
    ? h("div", { class: "detect-preview" }, h("div", { class: "detect-shot" }, editor.stage, meterSlot), editor.toolbar, ptzNote)
    : h(
        "div",
        { class: "detect-preview-ph" },
        h("span", { class: "cam-ph" }, icon(camera ? "power" : "camera", 22)),
        h("p", null, camera ? "這台攝影機已停用。啟用並儲存後，才能在這裡看到畫面、畫出不需要偵測的區域。" : "加入之後，可以回到這裡看即時的畫面變化，並畫出不需要偵測的區域。"),
      );

  // ---------- 靈敏度 ----------
  let sens: Sensitivity = sensitivityOf(d.threshold);
  const sensHint = h("small", { class: "hint" });
  const customWord = h("span", { class: "range-value" });
  const customRow = h(
    "div",
    { class: "range-row" },
    h("span", { class: "range-end" }, "保守"),
    slider("自訂靈敏度", thresholdToPos(d.threshold), (pos) => {
      d.threshold = posToThreshold(pos);
      refresh();
    }),
    h("span", { class: "range-end" }, "靈敏"),
  );
  const customField = h("div", { class: "range-field" }, h("div", { class: "range-label" }, h("span", null, "自訂"), customWord), customRow);
  const sensitivity = h(
    "div",
    { class: "field" },
    h("span", { class: "legend" }, "靈敏度"),
    segmented("靈敏度", SENSITIVITY, sens, (v) => {
      sens = v;
      if (v !== "custom") d.threshold = SENSITIVITY_PRESETS[v];
      refresh();
    }),
    sensHint,
    customField,
  );

  // ---------- 進階 ----------
  const areaValue = h("span", { class: "range-value num" });
  const areaId = nextId("area");
  const area = h(
    "div",
    { class: "range-field" },
    h("div", { class: "range-label" }, h("span", { id: areaId }, "變化範圍超過"), areaValue),
    h(
      "div",
      { class: "range-row" },
      h("span", { class: "range-end" }, "小"),
      (() => {
        const s = slider("變化範圍超過多少才算有動作", areaToPos(d.minArea), (pos) => {
          d.minArea = posToArea(pos);
          refresh();
        });
        s.setAttribute("aria-labelledby", areaId);
        return s;
      })(),
      h("span", { class: "range-end" }, "大"),
    ),
    h("small", { class: "hint" }, "畫面裡有這麼大的範圍在變化，才算有動作。調大可以忽略小動物和落葉；即時畫面變化的曲線會跟著改。"),
  );
  const cooldown = choice(
    "事件結束前等待",
    [5, 10, 30].map((v) => ({ value: v, label: `${v} 秒` })),
    d.cooldownSec,
    "秒",
  );
  cooldown.input.min = "1";
  cooldown.input.max = "300";
  cooldown.el.addEventListener("input", () => {
    const v = cooldown.value();
    if (Number.isFinite(v)) d.cooldownSec = Math.min(300, Math.max(1, Math.round(v)));
  });
  const more = h(
    "details",
    { class: "detect-more" },
    h("summary", null, icon("chevron", 15), "更多選項"),
    h(
      "div",
      { class: "detect-more-body" },
      area,
      h("div", { class: "field" }, h("span", { class: "legend" }, "動作停止後，再等多久結束事件"), cooldown.el, h("small", { class: "hint" }, "等待期間又有動作，會算在同一筆事件裡。")),
    ),
  );
  if (d.minArea !== DEFAULT_DETECT.minArea || d.cooldownSec !== DEFAULT_DETECT.cooldownSec) more.open = true;

  const pixelOnly = h("div", { class: "form" }, preview, sensitivity);
  const body = h("div", { class: "form" }, source, pixelOnly, more);
  const el = panelSection("動作偵測", null, h("div", { class: "switch-list" }, enabled), body);
  el.classList.add("detect-section");

  // ---------- 即時資料：只有已加入、啟用中的攝影機才有 ----------
  let snapshotOn = false;
  const loadSnapshot = async () => {
    if (!camera || !snapshotOn) return;
    try {
      const res = await fetch(api.snapshotUrl(camera.id, Date.now()), { credentials: "same-origin" });
      if (!ctx.isCurrent()) return;
      if (!res.ok) return editor.setImage(null, res.status === 404 ? "這台攝影機已停用" : "目前拿不到畫面，相機可能連不上");
      editor.setImage(URL.createObjectURL(await res.blob()));
    } catch {
      editor.setImage(null, "目前拿不到畫面");
    }
  };
  if (live) {
    ctx.every(SNAPSHOT_MS, () => void loadSnapshot());
    ctx.onCleanup(() => meter?.destroy());
    // 能轉的鏡頭才需要提醒遮罩會錯位；問不到就照有沒有 ONVIF 猜
    void api.ptz(camera.id).then(
      (p) => (ptzNote.hidden = !p.supported),
      () => (ptzNote.hidden = !onvif),
    );
  }

  function refresh() {
    body.hidden = !d.enabled;
    const src = SOURCES.find((s) => s.value === d.source)!;
    sourceHint.textContent = src.hint;
    const needOnvif = d.source !== "pixel" && !onvif;
    onvifWarn.hidden = !needOnvif;
    onvifWarn.lastElementChild!.textContent =
      d.source === "onvif"
        ? "這台沒有設定 ONVIF，收不到相機的偵測。請在下方「進階設定」開啟「使用 ONVIF」，或改用畫面變化。"
        : "這台沒有設定 ONVIF，目前只會用畫面變化偵測。要一起用相機偵測，請在下方「進階設定」開啟「使用 ONVIF」。";

    const pixel = d.enabled && d.source !== "onvif";
    pixelOnly.hidden = !pixel;
    area.hidden = !pixel;

    sensHint.textContent = SENSITIVITY_HINT[sens];
    customField.hidden = sens !== "custom";
    customWord.textContent = sensitivityWord(d.threshold);
    customRow.querySelector("input")!.setAttribute("aria-valuetext", sensitivityWord(d.threshold));
    areaValue.textContent = `畫面的 ${formatArea(d.minArea)}`;
    area.querySelector("input")!.setAttribute("aria-valuetext", `畫面的 ${formatArea(d.minArea)}`);

    if (!live) return;
    const wantLive = pixel;
    if (wantLive !== snapshotOn) {
      snapshotOn = wantLive;
      if (wantLive) void loadSnapshot();
    }
    if (wantLive && !meter) {
      meter = scoreMeter(camera!.id, d.minArea);
      meterSlot.replaceChildren(meter.el);
    } else if (!wantLive && meter) {
      meter.destroy();
      meter = null;
      meterSlot.replaceChildren();
    }
    meter?.setMinArea(d.minArea);
    meter?.setPending(d.threshold !== saved.threshold || !sameMasks(d.masks, saved.masks));
  }
  refresh();

  return {
    el,
    value: () => ({ ...d, masks: editor.value() }),
    setOnvif(available) {
      if (available === onvif) return;
      onvif = available;
      refresh();
    },
  };
}
