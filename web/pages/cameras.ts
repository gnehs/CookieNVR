import type { CameraDto, EventDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { emptyState, h, icon } from "../dom.ts";
import { alertSummary, cameraStatus, EVENT_ACTIVE } from "../health.ts";
import { onHealth } from "../health-watch.ts";
import { liveFrame, type LiveFrame } from "../live/frame.ts";
import { playGrid } from "../live/transport.ts";
import { liveSupported } from "../live/video.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { onStatus } from "../status-stream.ts";

interface Tile {
  el: HTMLAnchorElement;
  frame: LiveFrame;
  update(cam: CameraDto): void;
  /** 這台有進行中的事件 */
  setEvent(active: boolean): void;
}

function tile(initial: CameraDto): Tile {
  const frame = liveFrame(initial);
  const status = h("span", { class: "cam-status" }, h("i", { "aria-hidden": "true" }), h("span"));
  frame.el.append(status);
  const nameText = h("span", { class: "cam-name-text" });
  const name = h("span", { class: "cam-name" }, h("i", { class: "cam-event-dot", "aria-hidden": "true", title: EVENT_ACTIVE.label }), nameText);
  const el = h("a", { class: "cam-tile" }, frame.el, name);
  let current = initial;
  let eventActive = false;

  const update = (cam: CameraDto) => {
    current = cam;
    const st = cameraStatus(cam);
    el.href = `#/cameras/${encodeURIComponent(cam.id)}`;
    el.dataset.status = st.kind;
    el.dataset.tone = st.tone;
    el.title = cam.config.name;
    el.setAttribute("aria-label", [cam.config.name, st.quiet ? null : st.label, eventActive ? EVENT_ACTIVE.label : null].filter(Boolean).join("，"));
    nameText.textContent = cam.config.name;
    status.hidden = st.quiet;
    status.lastElementChild!.textContent = st.label;
    frame.update(cam);
  };

  update(initial);
  return {
    el,
    frame,
    update,
    setEvent(active) {
      if (active === eventActive) return;
      eventActive = active;
      el.toggleAttribute("data-event", active);
      update(current);
    },
  };
}

export async function camerasPage(ctx: PageCtx): Promise<Node> {
  const list = h("div");
  const grid = h("div", { class: "cam-grid" });
  const alertText = h("span", { class: "home-alert-text" });
  const alert = h("a", { class: "home-alert", href: "#/settings/status", hidden: true }, h("i", { class: "home-alert-dot", "aria-hidden": "true" }), alertText, h("span", { class: "home-alert-go" }, "查看", icon("chevron", 16)));
  const isAdmin = state.me?.role === "admin";
  const tiles = new Map<string, Tile>();

  // 多宮格的即時畫面共用一條連線；啟用中的攝影機組合變了才重開
  let gridKey = "";
  let stopGrid = () => {};
  const syncGrid = (cams: CameraDto[]) => {
    const live = cams.filter((c) => c.config.enabled);
    const key = live.map((c) => c.id).join(",");
    if (key === gridKey) return;
    gridKey = key;
    stopGrid();
    stopGrid = playGrid(live.map((c) => c.id), "sd", live.map((c) => tiles.get(c.id)!.frame.target));
  };
  ctx.onCleanup(() => {
    stopGrid();
    for (const t of tiles.values()) t.frame.destroy();
  });

  // 狀態推送只更新既有卡片，畫面不重建
  const render = (cams: CameraDto[]) => {
    addBtn.hidden = cams.length === 0;
    if (cams.length === 0) {
      for (const t of tiles.values()) t.frame.destroy();
      tiles.clear();
      syncGrid([]);
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
    for (const [id, t] of [...tiles]) {
      if (seen.has(id)) continue;
      t.frame.destroy();
      tiles.delete(id);
    }
    // 順序沒變就不動 DOM，避免更新時把鍵盤焦點弄丟
    if (els.length !== grid.children.length || els.some((e, i) => grid.children[i] !== e)) grid.replaceChildren(...els);
    if (!list.contains(grid)) list.replaceChildren(grid);
    syncGrid(cams);
  };

  const addBtn = h("a", { class: "btn", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機");
  const markEvents = (events: EventDto[]) => {
    for (const [id, t] of tiles) t.setEvent(events.some((e) => e.cameraId === id));
  };
  render(await api.cameras());
  ctx.onCleanup(
    onStatus((s) => {
      if (!ctx.isCurrent()) return;
      render(s.cams);
      markEvents(s.events);
    }),
  );
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
    liveSupported() ? null : h("p", { class: "live-fallback-note" }, icon("info", 16), "這個瀏覽器不支援即時影像，畫面每 3 秒更新一次。"),
    list,
  );
}
