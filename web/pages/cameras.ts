import type { CameraDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { badge, emptyState, h, icon, pageHeader } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";

function card(cam: CameraDto): HTMLElement {
  const c = cam.config;
  const type = c.connection.type === "tapo" ? "Tapo" : "RTSP";
  const statusBadges = !c.enabled
    ? [badge("已停用")]
    : [badge(cam.online ? "上線" : "離線", cam.online ? "ok" : "bad"), badge(cam.recording ? "錄影中" : "未錄影", cam.recording ? "ok" : "muted")];
  return h(
    "article",
    { class: "card cam-card" },
    h(
      "div",
      { class: "cam-top" },
      h("span", { class: "cam-ico" }, icon("camera", 20)),
      h("div", null, h("h3", null, c.name), h("div", { class: "cam-sub" }, type)),
    ),
    h("div", { class: "badges" }, statusBadges),
    h("a", { class: "btn", href: `#/recordings?camera=${encodeURIComponent(cam.id)}` }, icon("film"), "查看錄影"),
  );
}

export async function camerasPage(ctx: PageCtx): Promise<Node> {
  const list = h("div");
  const render = (cams: CameraDto[]) => {
    if (cams.length === 0) {
      list.replaceChildren(
        emptyState(
          "還沒有攝影機",
          state.me?.role === "admin" ? "新增第一台攝影機後就會開始錄影。" : "請管理員新增攝影機。",
          state.me?.role === "admin" ? h("a", { class: "btn primary", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機") : undefined,
        ),
      );
      return;
    }
    list.replaceChildren(h("div", { class: "grid" }, cams.map(card)));
  };
  render(await api.cameras());
  ctx.every(5000, () => {
    api.cameras().then((c) => ctx.isCurrent() && render(c), () => {});
  });
  return h("div", null, pageHeader("攝影機"), list);
}
