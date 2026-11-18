import { api } from "../api.ts";
import { badge, confirmDialog, copyButton, errMsg, formatBytes, formatClock, h, icon, panel, toast } from "../dom.ts";
import type { Issue } from "../health.ts";
import { type HealthSnapshot, onHealth, refreshHealth } from "../health-watch.ts";
import type { PageCtx } from "../router.ts";
import { settingsLayout } from "./settings-shell.ts";

type Action = { label: string; icon: string; run: () => Promise<void> } | { label: string; icon: string; href: string };

async function restartWorkers(ids: string[], title: string, message: string, done: string) {
  if (!(await confirmDialog(title, message, { confirmLabel: "繼續" }))) return;
  try {
    for (const id of ids) await api.restartWorker(id);
    toast(done);
    refreshHealth().catch(() => {});
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

const editHref = (id: string) => `#/settings/cameras/${encodeURIComponent(id)}`;

/** 每一類問題的說明只寫一次，並只給一個最可能有用的動作 */
function explain(issue: Issue, snap: HealthSnapshot): { body: string; action?: Action } {
  const one = issue.cameras.length === 1;
  switch (issue.kind) {
    case "restream":
      return {
        body: "所有攝影機的畫面都會經過這個服務，它停下來時畫面與錄影都會中斷。可以先試著重新啟動，期間會中斷幾秒。",
        action: { label: "重新啟動影像服務", icon: "refresh", run: () => restartWorkers(["restream"], "重新啟動影像服務？", "所有攝影機的畫面與錄影會中斷幾秒鐘。", "已重新啟動影像服務") },
      };
    case "offline":
      return {
        body: `收不到${one ? "這台" : "這些"}攝影機的畫面，所以也沒辦法錄影。常見原因是相機斷電、Wi-Fi 斷線，或 IP 位址變了。請確認相機有開機；如果最近換過路由器，到攝影機設定更新 IP。`,
        action: one ? { label: "檢查攝影機設定", icon: "edit", href: editHref(issue.cameras[0]!.id) } : { label: "查看攝影機設定", icon: "edit", href: "#/settings/cameras" },
      };
    case "notRecording":
      return {
        body: "畫面正常，但錄影一直無法開始，常見原因是儲存空間不足或寫不進儲存位置。可以先重新開始錄影；問題持續的話，用頁面下方的「複製診斷資訊」找原因。",
        action: {
          label: "重新開始錄影",
          icon: "refresh",
          run: () =>
            restartWorkers(
              issue.cameras.map((c) => `record:${c.id}`),
              one ? `重新開始「${issue.cameras[0]!.name}」的錄影？` : `重新開始 ${issue.cameras.length} 台的錄影？`,
              "錄影會中斷幾秒鐘。",
              "已重新開始錄影",
            ),
        },
      };
    case "unstable":
      return { body: "最近 10 分鐘內錄影中斷又自動恢復了很多次，常見原因是網路訊號不穩。可以把相機移近路由器，或改用有線網路。" };
    case "diskLow":
      return {
        body: `剩下 ${formatBytes(snap.health.disk.free)}，低於設定的最低剩餘空間，系統正在刪除最舊的錄影來騰出空間。可以縮短保留天數，或換一顆更大的硬碟。`,
        action: { label: "調整保留設定", icon: "hdd", href: "#/settings/storage" },
      };
    case "diskFull":
      return {
        body: `已用 ${snap.health.disk.usedPct.toFixed(0)}%。空間用完前會自動刪除最舊的錄影，但可以先縮短保留天數，避免重要片段被刪掉。`,
        action: { label: "調整保留設定", icon: "hdd", href: "#/settings/storage" },
      };
  }
}

function issueCard(issue: Issue, snap: HealthSnapshot): HTMLElement {
  const { body, action: a } = explain(issue, snap);
  const action = !a
    ? null
    : "href" in a
      ? h("a", { class: "btn small", href: a.href }, icon(a.icon, 15), a.label)
      : h("button", { class: "btn small", type: "button", onclick: () => void a.run() }, icon(a.icon, 15), a.label);
  return h(
    "article",
    { class: "issue", "data-tone": issue.tone },
    icon(issue.tone === "bad" ? "alert-circle" : "alert", 20),
    h("h3", null, issue.title),
    h("p", null, body),
    action ? h("div", { class: "issue-actions" }, action) : null,
  );
}

export async function settingsStatusPage(ctx: PageCtx): Promise<Node> {
  const healthEl = h("div");
  const issuesEl = h("div", { class: "issues", "aria-live": "polite" });
  const camsTitle = h("span");
  const camsBody = h("div", { class: "status-list" });
  const camsPanel = panel({ title: camsTitle }, camsBody);
  const diskBody = h("div", { class: "panel-section" });
  const stamp = h("span", { class: "num" });
  let lastKey = "";

  function paint(snap: HealthSnapshot) {
    stamp.textContent = `每 5 秒自動更新・上次 ${formatClock(snap.at)}`;
    const hl = snap.health;
    // 問題已經在上面的卡片說過，下面只列沒事的攝影機
    const fine = snap.cams.filter((c) => !hl.statuses.get(c.id)!.problem);
    // 內容沒變就不重畫，輪詢時不會把鍵盤焦點弄丟
    const key = JSON.stringify([hl.issues, fine.map((c) => [c.id, c.config.name, hl.statuses.get(c.id)!.kind]), snap.cams.length, Math.round(hl.disk.usedPct), hl.disk.tone]);
    if (key === lastKey) return;
    lastKey = key;

    const n = hl.issues.length;
    const active = snap.cams.filter((c) => c.config.enabled).length;
    const recording = fine.filter((c) => hl.statuses.get(c.id)!.kind === "recording").length;
    const tone = n === 0 ? "ok" : hl.issues.some((i) => i.tone === "bad") ? "bad" : "warn";
    healthEl.replaceChildren(
      h(
        "section",
        { class: "health", "data-tone": tone, "aria-label": "整體狀態" },
        h("span", { class: "health-ico" }, icon(tone === "ok" ? "check-circle" : "alert-circle", 26)),
        h(
          "div",
          { class: "health-text" },
          h("h2", null, n === 0 ? "一切正常" : `有 ${n} 件事需要處理`),
          n === 0 ? h("p", null, active === 0 ? "還沒有啟用中的攝影機。" : recording === active ? `${active} 台攝影機都在錄影。` : `${active} 台攝影機都已連線。`) : null,
        ),
      ),
    );
    issuesEl.replaceChildren(...hl.issues.map((i) => issueCard(i, snap)));
    issuesEl.hidden = n === 0;

    camsTitle.textContent = n > 0 ? "其他攝影機" : "攝影機";
    camsPanel.hidden = snap.cams.length > 0 && fine.length === 0;
    camsBody.replaceChildren(
      ...(snap.cams.length
        ? fine.map((c) => {
            const st = hl.statuses.get(c.id)!;
            return h("div", { class: "status-row" }, h("b", { title: c.config.name }, c.config.name), badge(st.label, st.tone));
          })
        : [h("div", { class: "state bare" }, h("p", null, "還沒有攝影機。"), h("a", { class: "btn small", href: "#/settings/cameras/new" }, icon("plus", 15), "新增攝影機"))]),
    );

    const d = hl.disk;
    diskBody.replaceChildren(
      h(
        "div",
        { class: "disk" },
        h("div", { class: "disk-big" }, h("b", null, formatBytes(d.free)), h("span", { class: "muted" }, `可用，共 ${formatBytes(d.total)}`)),
        h("div", { class: `bar${d.tone === "bad" ? " bad" : d.tone === "warn" ? " warn" : ""}`, role: "img", "aria-label": `已用 ${d.usedPct.toFixed(0)}%` }, h("i", { style: `width:${d.usedPct.toFixed(1)}%` })),
        h("div", { class: "disk-nums" }, h("span", { class: "num" }, `已用 ${d.usedPct.toFixed(0)}%`), h("a", { href: "#/settings/storage" }, "管理儲存空間")),
      ),
    );
  }

  await refreshHealth();
  ctx.onCleanup(onHealth((s) => ctx.isCurrent() && paint(s)));

  return settingsLayout(
    "status",
    h(
      "div",
      { class: "stack" },
      healthEl,
      issuesEl,
      camsPanel,
      panel({ title: "儲存空間" }, diskBody),
      h(
        "footer",
        { class: "status-foot" },
        h("span", null, "遇到問題時，可以複製診斷資訊貼給 AI 或技術人員，密碼等資料會自動遮蔽。"),
        h("div", { class: "form-actions" }, stamp, copyButton("複製診斷資訊", () => api.diagnostics(), { class: "small", done: "已複製診斷資訊，可以貼給 AI 或技術人員" })),
      ),
    ),
  );
}
