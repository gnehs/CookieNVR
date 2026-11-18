import type { SystemDto } from "../../src/api-types.ts";
import type { Settings } from "../../src/types.ts";
import { api } from "../api.ts";
import { choice, confirmDialog, errMsg, field, formatBytes, h, icon, panel, panelSection, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { estimateDays } from "../retention-estimate.ts";
import { settingsLayout } from "./settings-shell.ts";

const GB = 1024 ** 3;
export async function settingsStoragePage(_ctx: PageCtx): Promise<Node> {
  const [settings, sys, cams] = await Promise.all([api.settings(), api.system(), api.cameras()]);
  const r = settings.retention;
  const cont = choice("連續錄影保留天數", [3, 7, 14, 30].map((d) => ({ value: d, label: `${d} 天` })).concat({ value: 0, label: "不限" }), r.continuousDays, "天");
  const evt = choice("事件片段保留天數", [7, 30, 90].map((d) => ({ value: d, label: `${d} 天` })).concat({ value: 0, label: "不限" }), r.eventDays, "天");
  const free = choice("最低剩餘空間", [2, 5, 10, 20].map((g) => ({ value: g, label: `${g} GB` })), Math.round((r.minFreeBytes / GB) * 10) / 10, "GB", { step: 0.1 });
  const path = h("input", { type: "text", required: true, spellcheck: "false", autocapitalize: "off", autocomplete: "off", name: "storagePath" });
  path.value = settings.storagePath;
  const error = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "儲存變更");

  const estimate = h("div", { "aria-live": "polite" });
  const paintEstimate = () => {
    const minFree = free.value() * GB;
    const days = estimateDays(sys, Number.isFinite(minFree) ? minFree : r.minFreeBytes);
    const keep = cont.value();
    if (days === null) {
      estimate.replaceChildren(
        h("div", { class: "estimate" }, icon("clock", 22), h("div", null, h("b", null, "錄影一段時間後，這裡會估算可以保留幾天"), h("small", null, "空間不夠時，會從最舊的錄影開始刪除。"))),
      );
      return;
    }
    const d = Math.floor(days);
    const detail =
      keep > 0 && keep <= d
        ? `會保留最近 ${keep} 天，硬碟還有餘裕。`
        : keep > d
          ? `設定的 ${keep} 天比硬碟能存的多，空間不夠時會先刪除最舊的錄影。`
          : "沒有天數上限，空間不夠時會從最舊的錄影開始刪除。";
    estimate.replaceChildren(
      h("div", { class: "estimate" }, icon("hdd", 22), h("div", null, h("b", { class: "num" }, `以最近的用量，大約可以保留 ${d} 天的錄影`), h("small", null, detail))),
    );
  };
  paintEstimate();

  const form = panel(
    { tag: "form", class: "sticky-foot", foot: [error, save] },
    panelSection("連續錄影", "全天候錄下的影片要保留多久，超過就自動刪除。", cont.el, estimate),
    panelSection("事件片段", "偵測到動靜時的片段，通常可以保留得比連續錄影久。", evt.el),
    h(
      "details",
      { class: "disclosure" },
      h("summary", null, icon("chevron", 16), "進階設定", h("small", null, "儲存位置與保留空間")),
      h(
        "div",
        { class: "disclosure-body" },
        h("div", { class: "field" }, h("span", { class: "legend" }, "最低剩餘空間"), free.el, h("small", { class: "hint" }, "硬碟剩下的空間少於這個值時，會先刪除最舊的錄影。")),
        h("div", { class: "narrow" }, field("儲存位置", path, "錄影存放的資料夾。改了之後新的錄影會存到新位置，舊的留在原處，仍然可以回放。")),
      ),
    ),
  );
  form.addEventListener("input", paintEstimate);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const c = cont.value();
    const ev = evt.value();
    const f = free.value();
    if (![c, ev, f].every((n) => Number.isFinite(n) && n >= 0)) return void (error.textContent = "天數與空間請填 0 或更大的數字");
    if (!path.value.trim()) {
      path.closest("details")!.open = true;
      path.focus();
      return void (error.textContent = "請填寫儲存位置");
    }
    const patch: Partial<Settings> = {
      storagePath: path.value.trim(),
      retention: { continuousDays: Math.floor(c), eventDays: Math.floor(ev), minFreeBytes: Math.round(f * GB) },
    };
    save.disabled = true;
    try {
      await api.updateSettings(patch);
      toast("已儲存錄影與儲存設定");
    } catch (err) {
      error.textContent = errMsg(err);
    } finally {
      save.disabled = false;
    }
  });

  const names = new Map(cams.map((c) => [c.id as string, c.config.name]));
  const buildUsage = (sys: SystemDto): HTMLElement => {
    const total = sys.usage.reduce((a, u) => a + u.bytes, 0);
    const orphaned = sys.usage.filter((u) => !names.has(u.cameraId));
    const orphanBytes = orphaned.reduce((a, u) => a + u.bytes, 0);
    // 已刪除的攝影機可能不只一台，但使用者只需要看到一列，清除也是一次全清
    const rows = [
      ...sys.usage.filter((u) => names.has(u.cameraId)).map((u) => ({ name: names.get(u.cameraId)!, bytes: u.bytes, orphan: false })),
      ...(orphaned.length > 0 ? [{ name: "已刪除的攝影機", bytes: orphanBytes, orphan: true }] : []),
    ];
    const max = Math.max(1, ...rows.map((r) => r.bytes));
    const usedPct = sys.disk.totalBytes ? ((sys.disk.totalBytes - sys.disk.freeBytes) / sys.disk.totalBytes) * 100 : 0;
    const clearOrphans = async (button: HTMLButtonElement) => {
      const ok = await confirmDialog(
        "清除已刪除攝影機的錄影？",
        `這些攝影機已經不在了，錄影會立刻永久刪除，無法復原，並釋放 ${formatBytes(orphanBytes)}。其他攝影機的錄影不受影響。`,
        { confirmLabel: "清除錄影", danger: true },
      );
      if (!ok) return;
      button.disabled = true;
      try {
        const res = await api.purgeOrphanedRecordings();
        toast(`已清除，釋放 ${formatBytes(res.bytes)}`);
        usageEl.replaceWith((usageEl = buildUsage(await api.system())));
      } catch (err) {
        toast(errMsg(err), "error");
        button.disabled = false;
      }
    };
    return panel(
      { title: "空間使用" },
      panelSection(
        null,
        null,
        h(
          "div",
          { class: "disk" },
          h("div", { class: "disk-big" }, h("b", null, formatBytes(sys.disk.freeBytes)), h("span", { class: "muted" }, `可用，共 ${formatBytes(sys.disk.totalBytes)}`)),
          h("div", { class: `bar${usedPct > 95 ? " bad" : usedPct > 85 ? " warn" : ""}`, role: "img", "aria-label": `已用 ${usedPct.toFixed(0)}%` }, h("i", { style: `width:${usedPct.toFixed(1)}%` })),
          h("div", { class: "disk-nums" }, h("span", { class: "num" }, `已用 ${usedPct.toFixed(0)}%`), h("span", { class: "num" }, `錄影共 ${formatBytes(total)}`)),
        ),
      ),
      panelSection(
        "各攝影機",
        null,
        rows.length === 0
          ? h("p", { class: "muted" }, "還沒有錄影。")
          : h(
              "div",
              null,
              ...rows.map((r) => {
                const clear = !r.orphan
                  ? null
                  : h("button", { class: "btn small danger", type: "button", "aria-label": "清除已刪除攝影機的錄影", onclick: (e: Event) => void clearOrphans(e.currentTarget as HTMLButtonElement) }, "清除");
                return h(
                  "div",
                  { class: `usage-row${clear ? " has-action" : ""}` },
                  h("span", { title: r.name }, r.name),
                  h("div", { class: "bar", "aria-hidden": "true" }, h("i", { style: `width:${((r.bytes / max) * 100).toFixed(1)}%` })),
                  h("span", { class: "num" }, formatBytes(r.bytes)),
                  clear,
                );
              }),
            ),
      ),
    );
  };
  let usageEl = buildUsage(sys);
  return settingsLayout("storage", h("div", { class: "stack" }, form, usageEl));
}
