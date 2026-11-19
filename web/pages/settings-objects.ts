import type { ObjectModelDto, ObjectsDto } from "../../src/api-types.ts";
import type { ObjectSettings } from "../../src/types.ts";
import { api } from "../api.ts";
import { DEVICE_CHOICES, DEVICE_HINT, objectsView } from "../detect/object-model.ts";
import { errMsg, formatBytes, h, icon, panel, panelSection, segmented, switchInput, switchRow, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";

const POLL_MS = 3_000;

const modelLabel = (m: ObjectModelDto) => (m.builtin ? "內建模型" : m.sizeBytes ? `${m.name}（${formatBytes(m.sizeBytes)}）` : m.name);

/** 「設定 → 一般」裡的物件辨識：系統層級的開關、推論裝置與模型。變更立刻生效，狀態每幾秒更新 */
export async function objectsPanel(ctx: PageCtx): Promise<HTMLElement> {
  let data: ObjectsDto | null = await api.objects().catch(() => null);
  const settings = await api.settings();
  let cur: ObjectSettings = { ...settings.objects };

  const enabled = switchInput(cur.enabled);
  const status = h("div", { class: "obj-status", role: "status", "aria-live": "polite" });
  const warning = h("p", { class: "callout warn", hidden: true }, icon("alert"), h("span"));
  const deviceHint = h("small", { class: "hint" });
  const deviceSeg = h("div");
  const model = h("select", { "aria-label": "辨識模型", name: "objectModel" });
  const modelHint = h("small", { class: "hint" });
  const body = h("div", { class: "form obj-body" });

  const device = h("div", { class: "field" }, h("span", { class: "legend" }, "推論裝置"), deviceSeg, deviceHint);
  const modelField = h("div", { class: "field" }, h("label", { for: "objectModel" }, "辨識模型"), model, modelHint);
  model.id = "objectModel";
  body.append(status, warning, device, modelField);

  let deviceShown: string | null = null;
  function paintDevice() {
    deviceHint.textContent = DEVICE_HINT[cur.device];
    if (deviceShown === cur.device) return;
    deviceShown = cur.device;
    deviceSeg.replaceChildren(segmented("推論裝置", DEVICE_CHOICES, cur.device, (v) => void apply({ device: v })));
  }

  let modelKey = "";
  function paintModel() {
    const list = data?.models ?? [];
    const options: { value: string; label: string }[] = list.map((m) => ({ value: m.id, label: modelLabel(m) }));
    if (!options.some((o) => o.value === cur.model)) options.push({ value: cur.model, label: `${cur.model}（找不到檔案）` });
    const key = JSON.stringify([options, cur.model]);
    if (key !== modelKey) {
      modelKey = key;
      model.replaceChildren(...options.map((o) => h("option", { value: o.value, selected: o.value === cur.model }, o.label)));
      model.value = cur.model;
    }
    modelHint.replaceChildren(
      "想用自己的模型，把 .onnx 檔放到 ",
      h("code", { class: "path" }, data?.modelsDir ?? "models"),
      " 資料夾，過幾秒就會出現在上面的選單。",
    );
  }

  let statusKey = "";
  function paintStatus() {
    body.hidden = !cur.enabled;
    if (!cur.enabled) return;
    const key = JSON.stringify(data?.status ?? null);
    if (key === statusKey) return;
    statusKey = key;
    if (!data) {
      status.replaceChildren(h("span", { class: "obj-dot", "data-tone": "busy" }), h("div", { class: "obj-text" }, h("b", null, "暫時看不到狀態"), h("small", null, "稍後會自動再試。")));
      warning.hidden = true;
      return;
    }
    const v = objectsView(data.status);
    status.dataset.tone = v.tone;
    status.replaceChildren(
      v.tone === "busy" ? h("span", { class: "spin" }) : h("span", { class: "obj-dot", "data-tone": v.tone }),
      h("div", { class: "obj-text" }, h("b", null, v.title), v.note && h("small", null, v.note)),
    );
    warning.hidden = !v.warning;
    warning.lastElementChild!.textContent = v.warning ? v.warning : "";
  }

  const paint = () => {
    enabled.checked = cur.enabled;
    paintDevice();
    paintModel();
    paintStatus();
  };

  async function poll() {
    try {
      data = await api.objects();
    } catch {
      data = null;
    }
    if (ctx.isCurrent() && !busy) {
      paintModel();
      paintStatus();
    }
  }

  let busy = false;
  async function apply(patch: Partial<ObjectSettings>) {
    const before = cur;
    cur = { ...cur, ...patch };
    busy = true;
    enabled.disabled = model.disabled = true;
    paint();
    try {
      const res = await api.updateSettings({ objects: patch });
      cur = { ...res.objects };
      if (patch.enabled === false) toast("已關閉物件辨識");
    } catch (e) {
      cur = before;
      statusKey = "";
      toast(errMsg(e), "error");
    } finally {
      busy = false;
      enabled.disabled = model.disabled = false;
      paint();
    }
    void poll();
  }

  enabled.addEventListener("change", () => {
    statusKey = "";
    void apply({ enabled: enabled.checked });
  });
  model.addEventListener("change", () => void apply({ model: model.value }));

  paint();
  ctx.every(POLL_MS, () => cur.enabled && void poll());

  return panel(
    { title: "物件辨識" },
    panelSection(
      null,
      null,
      switchRow(enabled, "辨識畫面裡的人、車與動物", "開啟後，每台攝影機可以選擇只在看到人或車時才記錄事件。會多用一些電腦資源。"),
      body,
    ),
  );
}
