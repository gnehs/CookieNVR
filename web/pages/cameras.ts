import type { CameraDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { emptyState, h, icon } from "../dom.ts";
import { alertSummary, cameraStatus } from "../health.ts";
import { onHealth } from "../health-watch.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";

interface Tile {
  el: HTMLAnchorElement;
  update(cam: CameraDto): void;
  refreshSnapshot(): void;
}

function tile(initial: CameraDto): Tile {
  let cam = initial;
  const img = h("img", { alt: "", decoding: "async", hidden: true });
  const placeholder = h("span", { class: "cam-ph", "aria-hidden": "true" }, icon("camera", 22));
  const status = h("span", { class: "cam-status" }, h("i", { "aria-hidden": "true" }), h("span"));
  const name = h("span", { class: "cam-name" });
  const el = h("a", { class: "cam-tile" }, h("span", { class: "cam-frame" }, placeholder, img, status), name);

  let loadToken = 0;
  const showPlaceholder = () => {
    img.hidden = true;
    placeholder.hidden = false;
  };
  // 先在背景載好再換上，避免每次刷新都閃回佔位
  const refreshSnapshot = () => {
    if (!cam.config.enabled) return showPlaceholder();
    const token = ++loadToken;
    const probe = new Image();
    probe.onload = () => {
      if (token !== loadToken) return;
      img.src = probe.src;
      img.hidden = false;
      placeholder.hidden = true;
    };
    probe.onerror = () => token === loadToken && showPlaceholder();
    probe.src = api.snapshotUrl(cam.id, Date.now());
  };

  const update = (next: CameraDto) => {
    const wasEnabled = cam.config.enabled;
    cam = next;
    const st = cameraStatus(cam);
    el.href = `#/recordings?camera=${encodeURIComponent(cam.id)}`;
    el.dataset.status = st.kind;
    el.dataset.tone = st.tone;
    el.title = cam.config.name;
    el.setAttribute("aria-label", st.quiet ? `${cam.config.name}，查看錄影` : `${cam.config.name}，${st.label}，查看錄影`);
    name.textContent = cam.config.name;
    status.hidden = st.quiet;
    status.lastElementChild!.textContent = st.label;
    if (wasEnabled !== cam.config.enabled) refreshSnapshot();
  };

  update(initial);
  refreshSnapshot();
  return { el, update, refreshSnapshot };
}

export async function camerasPage(ctx: PageCtx): Promise<Node> {
  const list = h("div");
  const grid = h("div", { class: "cam-grid" });
  const alertText = h("span", { class: "home-alert-text" });
  const alert = h("a", { class: "home-alert", href: "#/settings/status", hidden: true }, h("i", { class: "home-alert-dot", "aria-hidden": "true" }), alertText, h("span", { class: "home-alert-go" }, "查看", icon("chevron", 16)));
  const isAdmin = state.me?.role === "admin";
  const tiles = new Map<string, Tile>();

  // 每 5 秒的清單輪詢只更新既有卡片，畫面不重建、快照不重抓
  const render = (cams: CameraDto[]) => {
    addBtn.hidden = cams.length === 0;
    if (cams.length === 0) {
      tiles.clear();
      list.replaceChildren(
        emptyState(
          "還沒有攝影機",
          isAdmin ? "加入第一台攝影機，馬上就會開始錄影。" : "請管理員加入攝影機。",
          isAdmin ? h("a", { class: "btn primary", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機") : undefined,
          "camera",
        ),
      );
      return;
    }
    const seen = new Set<string>();
    const els = cams.map((c) => {
      seen.add(c.id);
      const t = tiles.get(c.id);
      if (t) {
        t.update(c);
        return t.el;
      }
      const created = tile(c);
      tiles.set(c.id, created);
      return created.el;
    });
    for (const id of [...tiles.keys()]) if (!seen.has(id)) tiles.delete(id);
    // 順序沒變就不動 DOM，避免輪詢時把鍵盤焦點弄丟
    if (els.length !== grid.children.length || els.some((e, i) => grid.children[i] !== e)) grid.replaceChildren(...els);
    if (!list.contains(grid)) list.replaceChildren(grid);
  };

  const addBtn = h("a", { class: "btn", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機");
  render(await api.cameras());
  if (isAdmin) {
    ctx.onCleanup(
      onHealth(({ health }) => {
        const text = alertSummary(health.issues);
        alert.hidden = text === null;
        alert.dataset.tone = health.issues.some((i) => i.tone === "bad") ? "bad" : "warn";
        alertText.textContent = text ?? "";
      }),
    );
  }
  ctx.every(5000, () => {
    api.cameras().then((c) => ctx.isCurrent() && render(c), () => {});
  });
  ctx.every(10_000, () => {
    for (const t of tiles.values()) t.refreshSnapshot();
  });

  return h(
    "div",
    null,
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "攝影機"),
      isAdmin ? h("div", { class: "page-actions" }, addBtn) : null,
    ),
    alert,
    list,
  );
}
