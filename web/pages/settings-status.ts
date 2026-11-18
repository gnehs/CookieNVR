import type { SystemDto } from "../../src/api-types.ts";
import type { RestartReason, WorkerState, WorkerStatus } from "../../src/types.ts";
import { api } from "../api.ts";
import { confirmDialog, errMsg, formatAgo, formatBytes, formatDateTime, formatDuration, h, icon, panel, panelSection, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { settingsLayout } from "./settings-shell.ts";

const STATE_LABEL: Record<WorkerState, [string, "idle" | "off" | "bad" | "stop"]> = {
  starting: ["啟動中", "off"],
  running: ["運作中", "idle"],
  backoff: ["等待重試", "bad"],
  stopped: ["已停止", "stop"],
};
const REASON_LABEL: Record<RestartReason, string> = {
  exit: "程序異常結束",
  stall: "卡死",
  memory: "記憶體超限",
  manual: "手動重啟",
  "spec-changed": "設定變更",
};

export async function settingsStatusPage(ctx: PageCtx): Promise<Node> {
  const openIds = new Set<string>();
  const workersEl = h("div", { class: "workers" });
  const diskEl = h("div", { class: "disk" });
  const logEl = h("pre", { class: "log", tabindex: "0", "aria-label": "系統日誌" });
  logEl.style.maxHeight = "380px";
  const stamp = h("small", { class: "hint" });

  const restart = async (id: string) => {
    if (!(await confirmDialog(`重啟 ${id}？`, "這個程序會被停止後重新啟動，期間可能有幾秒鐘中斷。", { confirmLabel: "重啟" }))) return;
    try {
      await api.restartWorker(id);
      toast("已送出重啟");
      await refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  function worker(w: WorkerStatus): HTMLElement {
    const [label, tone] = STATE_LABEL[w.state];
    const details = h(
      "details",
      { open: openIds.has(w.id) },
      h("summary", null, `stderr 尾端（${w.stderrTail.length} 行）`),
      h("pre", { class: "log" }, w.stderrTail.length ? w.stderrTail.join("\n") : "（沒有輸出）"),
    );
    details.addEventListener("toggle", () => (details.open ? openIds.add(w.id) : openIds.delete(w.id)));
    return h(
      "article",
      { class: "band-card", "data-tone": tone },
      h("div", { class: "band" }, h("span", { class: "band-dot", "aria-hidden": "true" }), label, w.unstable ? "・不穩定" : ""),
      h(
        "div",
        { class: "band-body" },
        h(
          "div",
          { class: "dashed" },
          h(
            "div",
            { class: "band-title" },
            h("div", { style: "min-width:0" }, h("h3", { class: "worker-id" }, w.id), h("p", null, `類型 ${w.kind}${w.pid != null ? `・PID ${w.pid}` : ""}`)),
            h("button", { class: "btn small", type: "button", onclick: () => restart(w.id), "aria-label": `重啟 ${w.id}` }, icon("refresh", 15), "重啟"),
          ),
          w.lastRestart
            ? h("p", { class: "hint" }, `最近一次重啟：${REASON_LABEL[w.lastRestart.reason]}，${formatAgo(w.lastRestart.at)}${w.lastRestart.exitCode != null ? `（exit ${w.lastRestart.exitCode}）` : ""}`)
            : null,
        ),
        h(
          "div",
          { class: "meta-row" },
          h("span", null, icon("refresh", 14), `重啟 ${w.restarts} 次`),
          w.startedAt != null && w.state === "running" ? h("span", null, icon("clock", 14), `已運作 ${formatDuration(Date.now() - w.startedAt)}`) : null,
          w.unstable ? h("span", { class: "badge bad" }, "不穩定") : null,
        ),
        details,
      ),
    );
  }

  function paint(sys: SystemDto) {
    const ws = sys.workers.slice().sort((a, b) => Number(b.unstable) - Number(a.unstable) || a.id.localeCompare(b.id));
    workersEl.replaceChildren(...(ws.length ? ws.map(worker) : [h("p", { class: "muted" }, "沒有任何 worker。")]));

    const used = sys.disk.totalBytes - sys.disk.freeBytes;
    const pct = sys.disk.totalBytes ? (used / sys.disk.totalBytes) * 100 : 0;
    diskEl.replaceChildren(
      h("div", { class: "disk-big" }, h("b", null, `${pct.toFixed(0)}%`), h("span", { class: "muted" }, `已用 ${formatBytes(used)} / 共 ${formatBytes(sys.disk.totalBytes)}`)),
      h("div", { class: `bar${pct > 95 ? " bad" : pct > 85 ? " warn" : ""}` }, h("i", { style: `width:${pct.toFixed(1)}%` })),
      h("div", { class: "disk-nums" }, h("span", { class: "mono" }, sys.disk.path), h("span", null, `剩餘 ${formatBytes(sys.disk.freeBytes)}`)),
    );

    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
    logEl.textContent = sys.logs.length ? sys.logs.join("\n") : "（沒有日誌）";
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    stamp.textContent = `每 5 秒自動更新，上次 ${formatDateTime(Date.now()).slice(11)}`;
  }

  async function refresh() {
    const sys = await api.system();
    if (ctx.isCurrent()) paint(sys);
  }
  paint(await api.system());
  logEl.scrollTop = logEl.scrollHeight;
  ctx.every(5000, () => void refresh().catch(() => {}));

  return settingsLayout(
    "status",
    h(
      "div",
      { class: "stack" },
      h("section", null, h("div", { class: "page-head", style: "margin-bottom:12px" }, h("h2", { class: "step-title" }, "程序"), stamp), workersEl),
      panel({ title: "磁碟" }, panelSection(null, null, diskEl)),
      panel({ title: "日誌" }, h("div", { style: "padding:6px" }, logEl)),
    ),
  );
}
