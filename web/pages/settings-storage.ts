import type { Settings } from "../../src/types.ts";
import { api } from "../api.ts";
import { errMsg, formatBytes, h, nextId, panel, panelSection, stepper, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { settingsLayout } from "./settings-shell.ts";

const GB = 1024 ** 3;

function numberInput(value: number, opts: { min: number; step?: string }) {
  const input = h("input", { type: "number", min: opts.min, step: opts.step ?? "1", inputmode: "decimal", required: true });
  input.value = String(value);
  return input;
}

export async function settingsStoragePage(ctx: PageCtx): Promise<Node> {
  const [settings, sys, cams] = await Promise.all([api.settings(), api.system(), api.cameras()]);
  const path = h("input", { type: "text", required: true, spellcheck: "false", autocapitalize: "off" });
  path.value = settings.storagePath;
  const cont = numberInput(settings.retention.continuousDays, { min: 0 });
  const evt = numberInput(settings.retention.eventDays, { min: 0 });
  const free = numberInput(Math.round((settings.retention.minFreeBytes / GB) * 10) / 10, { min: 0, step: "0.1" });
  const error = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "儲存變更");

  const retentionField = (label: string, input: HTMLInputElement, presets: number[], hint: string) => {
    const id = nextId();
    input.id = id;
    const chips = presets.map((n) =>
      h("button", { type: "button", class: "preset", "aria-pressed": "false", onclick: () => {
        input.value = String(n);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } }, `${n} 天`),
    );
    const sync = () => chips.forEach((c, i) => c.setAttribute("aria-pressed", String(Number(input.value) === presets[i])));
    input.addEventListener("input", sync);
    sync();
    return h(
      "div",
      { class: "field" },
      h("label", { for: id }, label),
      stepper(input, "天", label),
      h("div", { class: "presets", role: "group", "aria-label": `${label}快速選擇` }, chips),
      h("small", { class: "hint" }, hint),
    );
  };

  const freeId = nextId();
  free.id = freeId;
  const form = panel(
    { tag: "form", class: "sticky-foot", title: "錄影與儲存", foot: [error, save] },
    panelSection("儲存路徑", "容器內的錄影根目錄。變更後所有錄影 worker 會重啟，舊錄影留在原處，仍可回放。", h("div", { class: "narrow" }, path)),
    panelSection(
      "保留期限",
      "超過天數的錄影會自動刪除。設為 0 表示不依天數刪除。",
      h(
        "div",
        { class: "retention" },
        retentionField("連續錄影", cont, [3, 7, 14, 30], "全天候的連續片段"),
        retentionField("事件", evt, [7, 30, 90], "偵測到事件時保留的片段"),
      ),
    ),
    panelSection(
      "最低剩餘空間",
      "剩餘空間低於此值時，會從最舊的連續錄影開始刪除。",
      h("div", { class: "field" }, h("label", { for: freeId, class: "sr-only" }, "最低剩餘空間"), stepper(free, "GB", "最低剩餘空間")),
    ),
  );
  path.setAttribute("aria-label", "儲存路徑");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const c = Number(cont.value);
    const ev = Number(evt.value);
    const f = Number(free.value);
    if (!path.value.trim()) return void (error.textContent = "請填寫儲存路徑");
    if (![c, ev, f].every((n) => Number.isFinite(n) && n >= 0)) return void (error.textContent = "天數與剩餘空間需為不小於 0 的數字");
    const patch: Partial<Settings> = {
      storagePath: path.value.trim(),
      retention: { continuousDays: Math.floor(c), eventDays: Math.floor(ev), minFreeBytes: Math.round(f * GB) },
    };
    save.disabled = true;
    try {
      await api.updateSettings(patch);
      toast("已儲存");
    } catch (err) {
      error.textContent = errMsg(err);
    } finally {
      save.disabled = false;
    }
  });

  const names = new Map(cams.map((c) => [c.id as string, c.config.name]));
  const total = sys.usage.reduce((a, u) => a + u.bytes, 0);
  const max = Math.max(1, ...sys.usage.map((u) => u.bytes));
  const usedPct = sys.disk.totalBytes ? ((sys.disk.totalBytes - sys.disk.freeBytes) / sys.disk.totalBytes) * 100 : 0;
  const diskBar = h("div", { class: `bar${usedPct > 95 ? " bad" : usedPct > 85 ? " warn" : ""}` }, h("i", { style: `width:${usedPct.toFixed(1)}%` }));

  const usage = panel(
    { title: "用量" },
    panelSection(
      null,
      null,
      h(
        "div",
        { class: "disk" },
        h("div", { class: "disk-big" }, h("b", null, formatBytes(sys.disk.freeBytes)), h("span", { class: "muted" }, `可用，共 ${formatBytes(sys.disk.totalBytes)}`)),
        diskBar,
        h("div", { class: "disk-nums" }, h("span", { class: "mono" }, sys.disk.path), h("span", null, `已用 ${usedPct.toFixed(0)}%`)),
      ),
    ),
    panelSection(
      "各攝影機",
      null,
      sys.usage.length === 0
        ? h("p", { class: "muted" }, "還沒有錄影。")
        : h(
            "div",
            null,
            ...sys.usage.map((u) =>
              h(
                "div",
                { class: "usage-row" },
                h("span", null, names.get(u.cameraId) ?? u.cameraId),
                h("div", { class: "bar" }, h("i", { style: `width:${((u.bytes / max) * 100).toFixed(1)}%` })),
                h("span", { class: "num" }, formatBytes(u.bytes)),
              ),
            ),
            h("div", { class: "usage-row" }, h("b", null, "合計"), h("span"), h("b", { class: "num" }, formatBytes(total))),
          ),
    ),
  );
  void ctx;
  return settingsLayout("storage", h("div", { class: "stack" }, form, usage));
}
