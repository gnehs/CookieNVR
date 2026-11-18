import type { CameraDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { emptyState, h, icon } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";

type Tone = "rec" | "idle" | "off" | "stop";

const STATUS: Record<Tone, string> = { rec: "錄影中", idle: "未錄影", off: "離線", stop: "已停用" };

function toneOf(cam: CameraDto): Tone {
  if (!cam.config.enabled) return "stop";
  if (cam.recording) return "rec";
  return cam.online ? "idle" : "off";
}

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
    const tone = toneOf(cam);
    el.href = `#/recordings?camera=${encodeURIComponent(cam.id)}`;
    el.dataset.tone = tone;
    el.title = cam.config.name;
    el.setAttribute("aria-label", `${cam.config.name}，${STATUS[tone]}，查看錄影`);
    name.textContent = cam.config.name;
    status.lastElementChild!.textContent = STATUS[tone];
    if (wasEnabled !== cam.config.enabled) refreshSnapshot();
  };

  update(initial);
  refreshSnapshot();
  return { el, update, refreshSnapshot };
}

function summary(cams: CameraDto[]): string {
  const rec = cams.filter((c) => toneOf(c) === "rec").length;
  const off = cams.filter((c) => toneOf(c) === "off").length;
  const parts = [`${cams.length} 台攝影機`, `${rec} 台錄影中`];
  if (off) parts.push(`${off} 台離線`);
  return parts.join("，");
}

export async function camerasPage(ctx: PageCtx): Promise<Node> {
  const list = h("div");
  const grid = h("div", { class: "cam-grid" });
  const sub = h("p");
  const isAdmin = state.me?.role === "admin";
  const tiles = new Map<string, Tile>();

  // 每 5 秒的清單輪詢只更新既有卡片，畫面不重建、快照不重抓
  const render = (cams: CameraDto[]) => {
    sub.textContent = cams.length ? summary(cams) : "";
    if (cams.length === 0) {
      tiles.clear();
      list.replaceChildren(
        emptyState(
          "還沒有攝影機",
          isAdmin ? "新增第一台攝影機後就會開始錄影。" : "請管理員新增攝影機。",
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

  render(await api.cameras());
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
      h("div", null, h("h1", null, "攝影機"), sub),
      isAdmin ? h("div", { class: "page-actions" }, h("a", { class: "btn", href: "#/settings/cameras/new" }, icon("plus"), "新增")) : null,
    ),
    list,
  );
}
