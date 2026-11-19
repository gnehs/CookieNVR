import type { SystemDto } from "../../src/api-types.ts";
import type { Settings } from "../../src/types.ts";
import { api } from "../api.ts";
import { confirmDialog, errMsg, formatBytes, h, icon, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { estimateDays } from "../retention-estimate.ts";
import { presetPicker, settingRow, settingsDisclosure, settingsGroup } from "../ui/settings-row.ts";
import { settingsLayout } from "./settings-shell.ts";

const GB = 1024 ** 3;
const days = (list: number[]) => [...list.map((d) => ({ value: d, label: `${d} 天` })), { value: 0, label: "不限" }];

interface Draft {
  continuousDays: number;
  eventDays: number;
  minFreeGb: number;
  storagePath: string;
}

const sameDraft = (a: Draft, b: Draft) => a.continuousDays === b.continuousDays && a.eventDays === b.eventDays && a.minFreeGb === b.minFreeGb && a.storagePath === b.storagePath;

export async function settingsStoragePage(_ctx: PageCtx): Promise<Node> {
  const [settings, sys0, cams] = await Promise.all([api.settings(), api.system(), api.cameras()]);
  let sys = sys0;
  const r = settings.retention;
  let saved: Draft = { continuousDays: r.continuousDays, eventDays: r.eventDays, minFreeGb: Math.round((r.minFreeBytes / GB) * 10) / 10, storagePath: settings.storagePath };

  const cont = presetPicker("連續錄影", days([3, 7, 14, 30]), saved.continuousDays, "天");
  const evt = presetPicker("事件片段", days([7, 30, 90]), saved.eventDays, "天");
  const free = presetPicker("最低剩餘空間", [2, 5, 10, 20].map((g) => ({ value: g, label: `${g} GB` })), saved.minFreeGb, "GB", { step: 0.1 });
  const path = h("input", { type: "text", required: true, spellcheck: "false", autocapitalize: "off", autocomplete: "off", name: "storagePath" });
  path.value = saved.storagePath;
  const error = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit", disabled: true }, "儲存變更");

  const draft = (): Draft => ({ continuousDays: cont.value(), eventDays: evt.value(), minFreeGb: free.value(), storagePath: path.value.trim() });

  const advanced = settingsDisclosure(
    "進階設定",
    () => {
      const f = free.value();
      return `保留 ${Number.isFinite(f) ? `${f} GB` : "—"} 空間 · ${path.value.trim() || "未設定位置"}`;
    },
    settingRow({ title: "最低剩餘空間", desc: "硬碟剩下的空間少於這個值時，先刪除最舊的錄影。", control: free.el, describe: free.focusable }),
    settingRow({ title: "儲存位置", desc: "錄影存放的資料夾。改了之後新的錄影存到新位置，舊的仍然可以回放。", input: path, wide: true }),
  );

  const form = h(
    "form",
    { class: "set-form", novalidate: true },
    settingsGroup(
      { title: "保留期限", desc: "超過就自動刪除；空間不夠時，不論天數都會先刪最舊的錄影。", foot: [error, save] },
      settingRow({ title: "連續錄影", desc: "全天候錄下的影片。", control: cont.el, describe: cont.focusable }),
      settingRow({ title: "事件片段", desc: "偵測到動靜時的片段，通常可以留得比連續錄影久。", control: evt.el, describe: evt.focusable }),
      advanced.el,
    ),
  );

  const onEdit = () => {
    advanced.refresh();
    paintEstimate();
    save.disabled = sameDraft(draft(), saved);
  };
  form.addEventListener("input", onEdit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const d = draft();
    if (![d.continuousDays, d.eventDays, d.minFreeGb].every((n) => Number.isFinite(n) && n >= 0)) return void (error.textContent = "天數與空間請填 0 或更大的數字");
    if (!d.storagePath) {
      advanced.el.open = true;
      path.focus();
      return void (error.textContent = "請填寫儲存位置");
    }
    if (d.storagePath !== saved.storagePath) {
      const ok = await confirmDialog("更改儲存位置？", `新的錄影會存到「${d.storagePath}」。舊的錄影留在原處，仍然可以回放，但不會搬過去。`, { confirmLabel: "更改並儲存" });
      if (!ok) return;
    }
    const patch: Partial<Settings> = {
      storagePath: d.storagePath,
      retention: { continuousDays: Math.floor(d.continuousDays), eventDays: Math.floor(d.eventDays), minFreeBytes: Math.round(d.minFreeGb * GB) },
    };
    save.disabled = true;
    try {
      await api.updateSettings(patch);
      saved = d;
      toast("已儲存錄影與儲存設定");
    } catch (err) {
      error.textContent = errMsg(err);
      save.disabled = false;
    }
  });

  // ---------- 儲存空間總覽：容量條、估算、各攝影機用量 ----------
  const names = new Map(cams.map((c) => [c.id as string, c.config.name]));
  const estimateEl = h("p", { class: "sto-estimate", "aria-live": "polite" });
  function paintEstimate() {
    const f = free.value();
    const est = estimateDays(sys, Number.isFinite(f) ? f * GB : saved.minFreeGb * GB);
    const keep = cont.value();
    estimateEl.classList.remove("warn");
    if (est === null) {
      estimateEl.replaceChildren(icon("clock", 17), h("span", null, "錄影一段時間後，這裡會估算大約可以存幾天。"));
      return;
    }
    const d = Math.floor(est);
    if (keep > d) {
      estimateEl.classList.add("warn");
      estimateEl.replaceChildren(icon("alert", 17), h("span", null, h("b", { class: "num" }, `空間只夠存約 ${d} 天`), `，比設定的 ${keep} 天少，最舊的錄影會提早刪除。`));
    } else if (keep > 0) {
      estimateEl.replaceChildren(icon("check-circle", 17), h("span", null, h("b", { class: "num" }, `大約可存 ${d} 天`), `的錄影。設定保留 ${keep} 天，空間足夠。`));
    } else {
      estimateEl.replaceChildren(icon("hdd", 17), h("span", null, h("b", { class: "num" }, `大約可存 ${d} 天`), "的錄影。沒有天數上限，空間不夠時從最舊的開始刪除。"));
    }
  }

  async function clearOrphans(button: HTMLButtonElement, bytes: number) {
    const ok = await confirmDialog("清除已刪除攝影機的錄影？", `這些攝影機已經不在了，錄影會立刻永久刪除，無法復原，並釋放 ${formatBytes(bytes)}。其他攝影機的錄影不受影響。`, {
      confirmLabel: "清除錄影",
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    try {
      const res = await api.purgeOrphanedRecordings();
      toast(`已清除，釋放 ${formatBytes(res.bytes)}`);
      sys = await api.system();
      const next = buildOverview();
      overview.replaceWith(next);
      overview = next;
      paintEstimate();
    } catch (err) {
      toast(errMsg(err), "error");
      button.disabled = false;
    }
  }

  function buildOverview(): HTMLElement {
    const { totalBytes, freeBytes } = sys.disk;
    const live = sys.usage.filter((u) => names.has(u.cameraId)).sort((a, b) => b.bytes - a.bytes);
    const orphanBytes = sys.usage.filter((u) => !names.has(u.cameraId)).reduce((a, u) => a + u.bytes, 0);
    const recorded = sys.usage.reduce((a, u) => a + u.bytes, 0);
    const other = Math.max(0, totalBytes - freeBytes - recorded);
    const pct = (n: number) => (totalBytes > 0 ? (n / totalBytes) * 100 : 0);
    // 攝影機依用量由大到小，用主色由深到淺；已刪除的攝影機用斜線，其他檔案用中性灰
    type Part = { name: string; bytes: number; kind: "cam" | "orphan" | "other"; shade?: number };
    const parts: Part[] = [
      ...live.map((u, i) => ({ name: names.get(u.cameraId)!, bytes: u.bytes, kind: "cam" as const, shade: i % 5 })),
      ...(orphanBytes > 0 ? [{ name: "已刪除的攝影機", bytes: orphanBytes, kind: "orphan" as const }] : []),
      ...(other > 0 ? [{ name: "其他檔案", bytes: other, kind: "other" as const }] : []),
    ];
    const usedPct = Math.round(pct(totalBytes - freeBytes));
    const bar = h(
      "div",
      { class: "sto-bar", role: "img", "aria-label": `已用 ${usedPct}%，${parts.map((p) => `${p.name} ${formatBytes(p.bytes)}`).join("、")}，可用 ${formatBytes(freeBytes)}` },
      parts.map((p) => h("i", { class: `sto-seg ${p.kind}`, "data-shade": p.shade ?? null, style: `width:${Math.max(pct(p.bytes), 0.6).toFixed(2)}%` })),
    );
    const legend = h(
      "ul",
      { class: "sto-legend" },
      parts.map((p) =>
        h(
          "li",
          { class: `sto-item ${p.kind}` },
          h("i", { class: `sto-swatch sto-seg ${p.kind}`, "data-shade": p.shade ?? null, "aria-hidden": "true" }),
          h("span", { class: "sto-name", title: p.name }, p.name),
          h("span", { class: "sto-size num" }, formatBytes(p.bytes)),
          p.kind === "orphan"
            ? h("button", { class: "btn small danger", type: "button", "aria-label": "清除已刪除攝影機的錄影", onclick: (e: Event) => void clearOrphans(e.currentTarget as HTMLButtonElement, p.bytes) }, "清除")
            : null,
        ),
      ),
      h("li", { class: "sto-item free" }, h("i", { class: "sto-swatch sto-seg free", "aria-hidden": "true" }), h("span", { class: "sto-name" }, "可用"), h("span", { class: "sto-size num" }, formatBytes(freeBytes))),
    );
    return settingsGroup(
      { title: "儲存空間", class: "sto" },
      h(
        "div",
        { class: "sto-body" },
        h(
          "div",
          { class: "sto-top" },
          h("div", { class: "sto-free" }, h("b", { class: "num" }, formatBytes(freeBytes)), h("span", null, "可用")),
          h("span", { class: "sto-total num" }, `共 ${formatBytes(totalBytes)} · 錄影佔 ${formatBytes(recorded)}`),
        ),
        bar,
        estimateEl,
      ),
      live.length || orphanBytes ? legend : h("p", { class: "sto-empty" }, "還沒有錄影。"),
    );
  }

  let overview = buildOverview();
  paintEstimate();
  return settingsLayout("storage", h("div", { class: "stack" }, overview, form));
}
