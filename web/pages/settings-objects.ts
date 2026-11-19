import type { ObjectModelDto, ObjectsDto } from "../../src/api-types.ts";
import type { ObjectSettings } from "../../src/types.ts";
import { api } from "../api.ts";
import { deviceHint, deviceOptions, FPS_HINT, FPS_OPTIONS, objectsView, unavailableNotes } from "../detect/object-model.ts";
import { errMsg, formatBytes, h, icon, panel, panelSection, switchInput, switchRow, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { benchmarkSection } from "./objects-benchmark.ts";

const POLL_MS = 3_000;
/** 測速中進度條要跟得上 */
const POLL_BENCH_MS = 1_000;

const modelLabel = (m: ObjectModelDto) => (m.builtin ? "內建模型" : m.sizeBytes ? `${m.name}（${formatBytes(m.sizeBytes)}）` : m.name);

/** 「設定 → 一般」裡的物件辨識：系統層級的開關、推論裝置、辨識頻率、模型與測速。變更立刻生效，狀態每幾秒更新 */
export async function objectsPanel(ctx: PageCtx): Promise<HTMLElement> {
  let data: ObjectsDto | null = await api.objects().catch(() => null);
  const settings = await api.settings();
  let cur: ObjectSettings = { ...settings.objects };
  let device = settings.devices.objects;

  const enabled = switchInput(cur.enabled);
  const status = h("div", { class: "obj-status", role: "status", "aria-live": "polite" });
  const warnings = h("div", { class: "obj-warnings" });
  const deviceSelect = h("select", { "aria-label": "推論裝置", name: "objectDevice", id: "objectDevice" });
  const deviceHintEl = h("small", { class: "hint" });
  const deviceNotes = h("div", { class: "obj-notes" });
  const fpsSelect = h("select", { "aria-label": "每秒辨識幾次", name: "objectFps", id: "objectFps" }, FPS_OPTIONS.map((o) => h("option", { value: String(o.value) }, o.label)));
  const model = h("select", { "aria-label": "辨識模型", name: "objectModel", id: "objectModel" });
  const modelHint = h("small", { class: "hint" });
  const bench = benchmarkSection(() => void poll());
  const body = h("div", { class: "form obj-body" });

  body.append(
    status,
    warnings,
    h("div", { class: "field" }, h("label", { for: "objectDevice" }, "推論裝置"), deviceSelect, deviceHintEl, deviceNotes),
    h("div", { class: "field" }, h("label", { for: "objectFps" }, "每秒辨識幾次"), fpsSelect, h("small", { class: "hint" }, FPS_HINT)),
    h("div", { class: "field" }, h("label", { for: "objectModel" }, "辨識模型"), model, modelHint),
    bench.el,
  );

  let deviceKey = "";
  function paintDevice() {
    const devices = data?.devices ?? [];
    const options = deviceOptions(devices, device);
    const key = JSON.stringify([options, device]);
    if (key !== deviceKey) {
      deviceKey = key;
      deviceSelect.replaceChildren(...options.map((o) => h("option", { value: o.value, selected: o.value === device }, o.label)));
      deviceSelect.value = device;
    }
    deviceHintEl.textContent = deviceHint(device, devices, data?.status.device ?? null);
    const notes = data ? unavailableNotes(data.unavailable, device) : { inline: [], folded: [] };
    const nKey = JSON.stringify(notes);
    if (nKey === deviceNotes.dataset.key) return;
    deviceNotes.dataset.key = nKey;
    deviceNotes.replaceChildren(
      ...notes.inline.map((t) => h("p", { class: "callout warn" }, icon("alert"), h("span", null, t))),
      ...(notes.folded.length
        ? [h("details", { class: "detect-more obj-details" }, h("summary", null, icon("chevron", 15), "找不到你的顯示卡？"), h("div", { class: "obj-folded" }, notes.folded.map((t) => h("small", { class: "hint" }, t))))]
        : []),
    );
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
      warnings.replaceChildren();
      return;
    }
    const v = objectsView(data.status);
    status.dataset.tone = v.tone;
    status.replaceChildren(
      v.tone === "busy" ? h("span", { class: "spin" }) : h("span", { class: "obj-dot", "data-tone": v.tone }),
      h("div", { class: "obj-text" }, h("b", null, v.title), v.note && h("small", null, v.note)),
    );
    warnings.replaceChildren(...v.warnings.map((w) => h("p", { class: "callout warn" }, icon("alert"), h("span", null, w))));
  }

  const paint = () => {
    enabled.checked = cur.enabled;
    fpsSelect.value = String(cur.fps);
    paintDevice();
    paintModel();
    paintStatus();
    bench.paint(data);
  };

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      data = await api.objects();
    } catch {
      data = null;
    } finally {
      polling = false;
    }
    if (ctx.isCurrent() && !busy) paint();
  }

  const controls = () => [enabled, deviceSelect, fpsSelect, model];
  let busy = false;
  async function apply(patch: { objects?: Partial<ObjectSettings>; devices?: { objects: string } }) {
    const before = { cur, device };
    cur = { ...cur, ...patch.objects };
    device = patch.devices?.objects ?? device;
    busy = true;
    for (const c of controls()) c.disabled = true;
    paint();
    try {
      const res = await api.updateSettings(patch);
      cur = { ...res.objects };
      device = res.devices.objects;
      if (patch.objects?.enabled === false) toast("已關閉物件辨識");
    } catch (e) {
      ({ cur, device } = before);
      statusKey = "";
      toast(errMsg(e), "error");
    } finally {
      busy = false;
      for (const c of controls()) c.disabled = false;
      paint();
    }
    void poll();
  }

  enabled.addEventListener("change", () => {
    statusKey = "";
    void apply({ objects: { enabled: enabled.checked } });
  });
  model.addEventListener("change", () => void apply({ objects: { model: model.value } }));
  fpsSelect.addEventListener("change", () => void apply({ objects: { fps: Number(fpsSelect.value) } }));
  deviceSelect.addEventListener("change", () => void apply({ devices: { objects: deviceSelect.value } }));

  paint();
  let tick = 0;
  ctx.every(POLL_BENCH_MS, () => {
    if (!cur.enabled) return;
    const benching = data?.benchmark?.state === "running" || data?.status.paused === "benchmark";
    if (benching || ++tick % (POLL_MS / POLL_BENCH_MS) === 0) void poll();
  });

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
