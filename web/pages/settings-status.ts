import type { CameraDto, SettingsDto, SystemDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { badge, confirmDialog, copyButton, errMsg, formatBytes, formatClock, h, icon, panel, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { settingsLayout } from "./settings-shell.ts";

type Tone = "ok" | "warn" | "bad" | "muted";

interface Issue {
  tone: "bad" | "warn";
  title: string;
  body: string;
  /** 只複製這一台的診斷資訊；null 代表整個系統 */
  camera: string | null;
  action?: { label: string; icon: string; run: () => Promise<void> } | { label: string; icon: string; href: string };
}

interface CameraRow {
  id: string;
  name: string;
  conn: [string, Tone];
  rec: [string, Tone];
}

interface Health {
  rows: CameraRow[];
  issues: Issue[];
  disk: { usedPct: number; free: number; total: number; tone: Tone };
}

async function restartWorker(id: string, title: string, message: string, done: string) {
  if (!(await confirmDialog(title, message, { confirmLabel: "繼續" }))) return;
  try {
    await api.restartWorker(id);
    toast(done);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** 把 worker、上線狀態與磁碟換成使用者在意的問題：哪一台、怎麼了、可以做什麼 */
function assess(sys: SystemDto, cams: CameraDto[], settings: SettingsDto): Health {
  const issues: Issue[] = [];
  const worker = (id: string) => sys.workers.find((w) => w.id === id);

  const restream = worker("restream");
  if (restream && (restream.state === "backoff" || restream.state === "stopped" || restream.unstable)) {
    issues.push({
      tone: "bad",
      title: "影像服務沒有正常運作",
      body: "所有攝影機的畫面都會經過這個服務，它停下來時畫面與錄影都會中斷。可以先試著重新啟動，期間會中斷幾秒。",
      camera: null,
      action: {
        label: "重新啟動影像服務",
        icon: "refresh",
        run: () => restartWorker("restream", "重新啟動影像服務？", "所有攝影機的畫面與錄影會中斷幾秒鐘。", "已重新啟動影像服務"),
      },
    });
  }

  const rows = cams.map((cam): CameraRow => {
    const c = cam.config;
    const name = c.name;
    if (!c.enabled) return { id: cam.id, name, conn: ["已停用", "muted"], rec: ["不錄影", "muted"] };
    const rec = worker(`record:${cam.id}`);
    if (!cam.online) {
      issues.push({
        tone: "bad",
        title: `${name}連不上`,
        body: "收不到這台攝影機的畫面，所以也沒辦法錄影。常見原因是相機斷電、Wi-Fi 斷線，或 IP 位址變了。請確認相機有開機；如果最近換過路由器，到攝影機設定更新 IP。",
        camera: cam.id,
        action: { label: "檢查攝影機設定", icon: "edit", href: `#/settings/cameras/${encodeURIComponent(cam.id)}` },
      });
      return { id: cam.id, name, conn: ["連不上", "bad"], rec: [c.record.enabled ? "等待畫面" : "未開啟", "muted"] };
    }
    if (!c.record.enabled) return { id: cam.id, name, conn: ["已連線", "ok"], rec: ["未開啟", "muted"] };
    if (!cam.recording) {
      issues.push({
        tone: "bad",
        title: `${name}沒有在錄影`,
        body: "畫面正常，但錄影一直無法開始，常見原因是儲存空間不足或寫不進儲存位置。可以先重新開始錄影；問題持續的話，複製診斷資訊來找原因。",
        camera: cam.id,
        action: {
          label: "重新開始錄影",
          icon: "refresh",
          run: () => restartWorker(`record:${cam.id}`, `重新開始「${name}」的錄影？`, "這台的錄影會中斷幾秒鐘。", "已重新開始錄影"),
        },
      });
      return { id: cam.id, name, conn: ["已連線", "ok"], rec: ["沒有在錄影", "bad"] };
    }
    if (rec?.unstable) {
      issues.push({
        tone: "warn",
        title: `${name}的錄影不太穩定`,
        body: "最近 10 分鐘內錄影中斷又自動恢復了很多次，常見原因是網路訊號不穩。可以把相機移近路由器，或改用有線網路。",
        camera: cam.id,
      });
      return { id: cam.id, name, conn: ["已連線", "ok"], rec: ["錄影不穩定", "warn"] };
    }
    return { id: cam.id, name, conn: ["已連線", "ok"], rec: ["錄影中", "ok"] };
  });

  const { totalBytes: total, freeBytes: free } = sys.disk;
  const usedPct = total ? ((total - free) / total) * 100 : 0;
  let diskTone: Tone = "ok";
  if (free < settings.retention.minFreeBytes) {
    diskTone = "bad";
    issues.push({
      tone: "bad",
      title: "儲存空間不足",
      body: `剩下 ${formatBytes(free)}，低於設定的最低剩餘空間，系統正在刪除最舊的錄影來騰出空間。可以縮短保留天數，或換一顆更大的硬碟。`,
      camera: null,
      action: { label: "調整保留設定", icon: "hdd", href: "#/settings/storage" },
    });
  } else if (usedPct >= 90) {
    diskTone = "warn";
    issues.push({
      tone: "warn",
      title: "儲存空間快滿了",
      body: `已用 ${usedPct.toFixed(0)}%。空間用完前會自動刪除最舊的錄影，但可以先縮短保留天數，避免重要片段被刪掉。`,
      camera: null,
      action: { label: "調整保留設定", icon: "hdd", href: "#/settings/storage" },
    });
  }
  issues.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
  return { rows, issues, disk: { usedPct, free, total, tone: diskTone } };
}

function headline(hl: Health): { title: string; sub: string; tone: "ok" | "warn" | "bad" } {
  const active = hl.rows.filter((r) => r.conn[1] !== "muted");
  if (hl.issues.length === 0) {
    const recording = hl.rows.filter((r) => r.rec[1] === "ok").length;
    return {
      title: "一切正常",
      tone: "ok",
      sub: active.length === 0 ? "還沒有啟用中的攝影機。" : recording === active.length ? `${active.length} 台攝影機都已連線並在錄影。` : `${active.length} 台攝影機都已連線。`,
    };
  }
  const tone = hl.issues.some((i) => i.tone === "bad") ? "bad" : "warn";
  if (hl.issues.length === 1) return { title: hl.issues[0]!.title, tone, sub: "其他項目都正常。" };
  return { title: `有 ${hl.issues.length} 件事需要處理`, tone, sub: "依影響程度排列，先處理最上面的。" };
}

const diagButton = (camera: string | null, label = "複製診斷資訊") =>
  copyButton(label, () => api.diagnostics(camera ?? undefined), {
    class: "small",
    done: "已複製診斷資訊，可以貼給 AI 或技術人員",
  });

function issueCard(issue: Issue): HTMLElement {
  const a = issue.action;
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
    h("p", null, issue.body),
    h("div", { class: "issue-actions" }, action, diagButton(issue.camera, issue.camera ? "複製這台的診斷資訊" : "複製診斷資訊")),
  );
}

export async function settingsStatusPage(ctx: PageCtx): Promise<Node> {
  const healthEl = h("div");
  const issuesEl = h("div", { class: "issues", "aria-live": "polite" });
  const camsBody = h("div", { class: "status-list" });
  const diskBody = h("div", { class: "panel-section" });
  const stamp = h("span", { class: "num" });
  let lastKey = "";

  function paint(sys: SystemDto, cams: CameraDto[], settings: SettingsDto) {
    stamp.textContent = `每 5 秒自動更新・上次 ${formatClock(Date.now())}`;
    const hl = assess(sys, cams, settings);
    // 內容沒變就不重畫，輪詢時不會把鍵盤焦點弄丟
    const key = JSON.stringify([hl.rows, hl.issues.map((i) => [i.title, i.tone]), Math.round(hl.disk.usedPct), hl.disk.tone]);
    if (key === lastKey) return;
    lastKey = key;

    const head = headline(hl);
    healthEl.replaceChildren(
      h(
        "section",
        { class: "health", "data-tone": head.tone, "aria-label": "整體狀態" },
        h("span", { class: "health-ico" }, icon(head.tone === "ok" ? "check-circle" : "alert-circle", 26)),
        h("div", { class: "health-text" }, h("h2", null, head.title), h("p", null, head.sub)),
      ),
    );
    issuesEl.replaceChildren(...hl.issues.map(issueCard));
    issuesEl.hidden = hl.issues.length === 0;

    camsBody.replaceChildren(
      ...(hl.rows.length
        ? hl.rows.map((r) =>
            h(
              "div",
              { class: "status-row" },
              h("b", { title: r.name }, r.name),
              h("div", { class: "badges" }, badge(r.conn[0], r.conn[1]), badge(r.rec[0], r.rec[1])),
            ),
          )
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

  const load = () => Promise.all([api.system(), api.cameras(), api.settings()]);
  const [sys, cams, settings] = await load();
  paint(sys, cams, settings);
  ctx.every(5000, () => {
    load().then(([a, b, c]) => ctx.isCurrent() && paint(a, b, c), () => {});
  });

  return settingsLayout(
    "status",
    h(
      "div",
      { class: "stack" },
      healthEl,
      issuesEl,
      panel({ title: "攝影機" }, camsBody),
      panel({ title: "儲存空間" }, diskBody),
      h(
        "footer",
        { class: "status-foot" },
        h("span", null, "遇到問題時，可以複製診斷資訊貼給 AI 或技術人員，密碼等資料會自動遮蔽。"),
        h("div", { class: "form-actions" }, stamp, diagButton(null)),
      ),
    ),
  );
}
