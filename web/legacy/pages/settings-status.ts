import { api } from "../api.ts";
import { badge, confirmDialog, copyButton, errMsg, formatBytes, formatClock, h, icon, toast } from "../dom.ts";
import type { Issue } from "../health.ts";
import { type HealthSnapshot, onHealth, pushMetrics, refreshHealth } from "../health-watch.ts";
import { CATEGORY_LABEL, createResourcesCard } from "../resources.ts";
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

interface Explained {
  /** 這一列的主角：攝影機名稱或「影像服務」「儲存空間」 */
  who: string;
  pill: { label: string; tone: "bad" | "warn" };
  /** 一句下一步，20 字以內 */
  next: string;
  /** 較長的可能原因，收在「可能的原因」裡 */
  why: string;
  action?: Action;
}

/** 「目前最花處理器的是錄影」；還沒算出各類用量時是空字串 */
function topUser(snap: HealthSnapshot, by: "cpuPct" | "memBytes"): string {
  const top = [...(snap.metrics?.usage ?? [])].sort((a, b) => b[by] - a[by])[0];
  return top && top[by] > 0 ? `目前用最多的是「${CATEGORY_LABEL[top.category]}」。` : "";
}

/** 每一類問題只寫一次：一句下一步、收起來的原因、一個最可能有用的動作 */
function explain(issue: Issue, snap: HealthSnapshot): Explained {
  const one = issue.cameras.length === 1;
  const names = issue.cameras.map((c) => c.name).join("、");
  switch (issue.kind) {
    case "restream":
      return {
        who: "影像服務",
        pill: { label: "已停止", tone: "bad" },
        next: "重新啟動就會恢復畫面與錄影",
        why: "所有攝影機的畫面都會經過這個服務，它停下來時畫面與錄影都會中斷。重新啟動期間會中斷幾秒。",
        action: { label: "重新啟動", icon: "refresh", run: () => restartWorkers(["restream"], "重新啟動影像服務？", "所有攝影機的畫面與錄影會中斷幾秒鐘。", "已重新啟動影像服務") },
      };
    case "objects":
      return {
        who: "物件辨識",
        pill: { label: "已停止", tone: "warn" },
        next: "重新啟動，通常就會恢復辨識",
        why: "物件辨識停下來時，錄影與動作偵測不受影響，只是事件不會標上看到的東西；設成「過濾」的攝影機會改成照一般動作建立事件。重新啟動後仍然停止，請用頁面下方的「複製診斷資訊」找原因，也可以到「設定 → 一般」換一個辨識模型或推論裝置。",
        action: { label: "重新啟動", icon: "refresh", run: () => restartWorkers(["detector"], "重新啟動物件辨識？", "辨識會中斷幾秒鐘，錄影不受影響。", "已重新啟動物件辨識") },
      };
    case "objectsLoad":
      return {
        who: "物件辨識",
        pill: { label: "跟不上", tone: "warn" },
        next: issue.title,
        why: "辨識跟不上時，多出來的畫面會被略過。錄影與動作偵測不受影響，但事件可能漏標上看到的東西。降低辨識頻率、改用更快的裝置，或到設定裡測速看看這台機器的能力，都能改善。",
        action: { label: "調整設定", icon: "settings", href: "#/settings/system" },
      };
    case "offline":
      return {
        who: names,
        pill: { label: "連不上", tone: "bad" },
        next: "確認相機有開機並連上網路",
        why: "收不到畫面，所以也沒辦法錄影。常見原因是相機斷電、Wi-Fi 斷線，或 IP 位址變了；如果最近換過路由器，到攝影機設定更新 IP。",
        action: one ? { label: "檢查設定", icon: "edit", href: editHref(issue.cameras[0]!.id) } : { label: "檢查設定", icon: "edit", href: "#/settings/cameras" },
      };
    case "notRecording":
      return {
        who: names,
        pill: { label: "沒在錄影", tone: "bad" },
        next: "重新開始錄影，通常就會恢復",
        why: "畫面正常，但錄影一直無法開始，常見原因是儲存空間不足或寫不進儲存位置。重新開始後仍然沒有錄影，請用頁面下方的「複製診斷資訊」找原因。",
        action: {
          label: "重新開始",
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
      return {
        who: names,
        pill: { label: "錄影不穩定", tone: "warn" },
        next: "把相機移近路由器或改用有線",
        why: "最近 10 分鐘內錄影中斷又自動恢復了很多次，常見原因是網路訊號不穩。",
      };
    case "diskLow":
      return {
        who: "儲存空間",
        pill: { label: "空間不足", tone: "bad" },
        next: "縮短保留天數或換更大的硬碟",
        why: `剩下 ${formatBytes(snap.health.disk.free)}，低於設定的最低剩餘空間，系統正在刪除最舊的錄影來騰出空間。`,
        action: { label: "調整保留", icon: "hdd", href: "#/settings/storage" },
      };
    case "diskFull":
      return {
        who: "儲存空間",
        pill: { label: "快滿了", tone: "warn" },
        next: "可以先縮短保留天數",
        why: `已用 ${snap.health.disk.usedPct.toFixed(0)}%。空間用完前會自動刪除最舊的錄影，縮短保留天數可以避免重要片段被刪掉。`,
        action: { label: "調整保留", icon: "hdd", href: "#/settings/storage" },
      };
    case "cpuBusy":
      return {
        who: "處理器",
        pill: { label: "長時間忙碌", tone: "warn" },
        next: "減少同時進行的工作，或換效能更好的主機",
        why: `過去 5 分鐘處理器幾乎一直在 90% 以上，畫面可能延遲、錄影可能掉格。${topUser(snap, "cpuPct")}可以關掉不需要的動作偵測、少開幾個即時畫面，或讓攝影機改用解析度較低的子碼流偵測。`,
      };
    case "memoryHigh":
      return {
        who: "記憶體",
        pill: { label: "快不夠了", tone: "warn" },
        next: "減少攝影機的工作，或增加記憶體",
        why: `過去 5 分鐘記憶體幾乎一直用到 90% 以上；用完時系統會強制結束程式，錄影可能中斷。${topUser(snap, "memBytes")}如果 CookieNVR 跑在 Docker 裡並設了記憶體上限，可以把上限調高。`,
      };
  }
}

/** 攝影機快照縮圖；取不到（例如連不上）就用跟首頁一樣的佔位 */
function thumb(cameraId: string): HTMLElement {
  const ph = () => h("span", { class: "cam-ph" }, icon("camera", 16));
  const box = h("span", { class: "issue-thumb" }, ph());
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.onload = () => box.replaceChildren(img);
  img.src = api.snapshotUrl(cameraId, Date.now());
  return box;
}

const SYSTEM_ICON: Partial<Record<Issue["kind"], string>> = { restream: "server", objects: "server", objectsLoad: "server", cpuBusy: "activity", memoryHigh: "activity" };

function issueRow(issue: Issue, snap: HealthSnapshot): HTMLElement {
  const e = explain(issue, snap);
  const a = e.action;
  const action = !a
    ? null
    : "href" in a
      ? h("a", { class: "btn small", href: a.href }, a.label)
      : h("button", { class: "btn small", type: "button", onclick: () => void a.run() }, a.label);
  const thumbs = issue.cameras.length
    ? h("span", { class: "issue-thumbs", "aria-hidden": "true" }, issue.cameras.slice(0, 3).map((c) => thumb(c.id)))
    : h("span", { class: "issue-thumbs", "aria-hidden": "true" }, h("span", { class: "issue-thumb sys" }, icon(SYSTEM_ICON[issue.kind] ?? "hdd", 18)));
  return h(
    "article",
    { class: "issue-row", "data-tone": issue.tone, "aria-label": issue.title },
    thumbs,
    h(
      "div",
      { class: "issue-main" },
      h("h3", null, h("span", { class: "issue-who" }, e.who), badge(e.pill.label, e.pill.tone)),
      h("p", { class: "issue-next" }, e.next),
      h("details", { class: "issue-why" }, h("summary", null, "可能的原因"), h("p", null, e.why)),
    ),
    action,
  );
}

export async function settingsStatusPage(ctx: PageCtx): Promise<Node> {
  const healthEl = h("div");
  const camsTitle = h("span");
  const camsBody = h("div", { class: "status-list" });
  // 跟上面的總結卡同一種單層卡片：標題＋內容，不再包外框
  const camsPanel = h("section", { class: "card" }, h("h2", { class: "card-title" }, camsTitle), camsBody);
  const diskBody = h("div", { class: "card-body" });
  const stamp = h("span", { class: "num" });
  const resources = createResourcesCard();
  resources.el.hidden = true;
  let lastKey = "";
  let lastSnap: HealthSnapshot | null = null;
  /** 物件辨識來不及處理的提醒（後端給的一般人看得懂的話）；沒問題或沒開為 null */
  let loadWarning: string | null = null;

  function paint(snap: HealthSnapshot) {
    lastSnap = snap;
    stamp.textContent = `每 5 秒自動更新・上次 ${formatClock(snap.at)}`;
    if (snap.metrics) {
      resources.el.hidden = false;
      resources.update(snap.metrics, snap.cams);
    }
    const base = snap.health;
    // 辨識程序已經停止時，說的是更根本的問題，不重複提醒負載
    const extra: Issue[] = loadWarning && !base.issues.some((i) => i.kind === "objects") ? [{ kind: "objectsLoad", tone: "warn", cameras: [], title: loadWarning, short: "物件辨識跟不上" }] : [];
    const hl = { ...base, issues: [...base.issues, ...extra].sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1)) };
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
    // 總結與問題放在同一張卡：一行總結，下面每個問題一列，細線分開
    healthEl.replaceChildren(
      h(
        "section",
        { class: "card health", "data-tone": tone, "aria-label": "整體狀態" },
        h(
          "header",
          { class: "health-head" },
          h("i", { class: "health-dot", "aria-hidden": "true" }),
          h("h2", null, n === 0 ? "一切正常" : `有 ${n} 件事需要處理`),
          n === 0 ? h("p", null, active === 0 ? "還沒有啟用中的攝影機。" : recording === active ? `${active} 台攝影機都在錄影。` : `${active} 台攝影機都已連線。`) : null,
        ),
        n ? h("div", { class: "issue-list", "aria-live": "polite" }, hl.issues.map((i) => issueRow(i, snap))) : null,
      ),
    );

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

  async function checkObjects() {
    if (!lastSnap?.settings.objects.enabled) return void (loadWarning = null);
    const next = await api.objects().then((o) => (o.status.paused ? loadWarning : o.status.warning), () => null);
    if (next === loadWarning || !ctx.isCurrent()) return;
    loadWarning = next;
    if (lastSnap) paint(lastSnap);
  }

  await refreshHealth();
  ctx.onCleanup(onHealth((s) => ctx.isCurrent() && paint(s)));
  // 系統資源只在這一頁每 5 秒抓（watch=1 讓後端讀 GPU 與各程序）；其他頁面跟著每分鐘的重抓判斷資源吃緊
  const pollMetrics = () => {
    if (!document.hidden && ctx.isCurrent()) api.metrics(true).then(pushMetrics, () => {});
  };
  pollMetrics();
  const metricsTimer = setInterval(pollMetrics, 5_000);
  ctx.onCleanup(() => clearInterval(metricsTimer));
  void checkObjects();
  ctx.every(5_000, () => void checkObjects());

  return settingsLayout(
    "status",
    h(
      "div",
      { class: "stack" },
      healthEl,
      camsPanel,
      h("section", { class: "card" }, h("h2", { class: "card-title" }, "儲存空間"), diskBody),
      resources.el,
      h(
        "footer",
        { class: "status-foot" },
        h("span", null, "遇到問題時，可以複製診斷資訊貼給 AI 或技術人員，密碼等資料會自動遮蔽。"),
        h("div", { class: "form-actions" }, stamp, copyButton("複製診斷資訊", () => api.diagnostics(), { class: "small", done: "已複製診斷資訊，可以貼給 AI 或技術人員" })),
      ),
    ),
  );
}
