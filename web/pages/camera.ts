import type { CameraDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { badge, emptyState, h, icon, segmented } from "../dom.ts";
import { cameraStatus } from "../health.ts";
import { liveFrame } from "../live/frame.ts";
import { playSingle, type Quality } from "../live/transport.ts";
import { liveSupported } from "../live/video.ts";
import type { PageCtx } from "../router.ts";
import { onStatus } from "../status-stream.ts";

const QUALITY_KEY = "cookienvr.liveQuality";

function savedQuality(): Quality {
  try {
    return localStorage.getItem(QUALITY_KEY) === "hd" ? "hd" : "sd";
  } catch {
    return "sd";
  }
}

function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {}
}

const notFound = () =>
  emptyState("找不到這台攝影機", "可能已經被刪除了。", h("a", { class: "btn", href: "#/cameras" }, icon("left"), "回到攝影機"), "camera");

/** 單台即時畫面：大畫面、畫質切換、去看這台的回放；其他細節不在這裡 */
export async function cameraPage(ctx: PageCtx, id: string): Promise<Node> {
  const cam = (await api.cameras()).find((c) => c.id === id);
  if (!cam) return notFound();

  let quality = savedQuality();
  const frame = liveFrame(cam);
  frame.el.classList.add("live-stage");
  const title = h("h1");
  const pill = h("span", { class: "live-pill" });
  const playback = h("a", { class: "btn primary", href: `#/recordings?camera=${encodeURIComponent(id)}` }, icon("film"), "看回放");
  const qualityPick = segmented<Quality>("畫質", [{ value: "sd", label: "標準" }, { value: "hd", label: "高畫質" }], quality, (q) => {
    quality = q;
    saveQuality(q);
    restart();
  });

  let current = cam;
  let stop = () => {};
  const restart = () => {
    stop();
    stop = current.config.enabled ? playSingle(id, quality, frame.target) : () => {};
  };
  ctx.onCleanup(() => {
    stop();
    frame.destroy();
  });

  const root = h("div", { class: "live-page" });
  const paint = (c: CameraDto) => {
    const wasEnabled = current.config.enabled;
    current = c;
    const st = cameraStatus(c);
    title.textContent = c.config.name;
    pill.replaceChildren(st.quiet ? "" : badge(st.label, st.tone));
    qualityPick.hidden = !c.config.enabled;
    frame.update(c);
    if (wasEnabled !== c.config.enabled) restart();
  };
  paint(cam);
  restart();
  ctx.onCleanup(
    onStatus((s) => {
      if (!ctx.isCurrent()) return;
      const next = s.cams.find((c) => c.id === id);
      if (next) paint(next);
      else {
        stop();
        root.replaceChildren(notFound());
      }
    }),
  );

  root.append(
    h(
      "header",
      { class: "page-head sub-head live-head" },
      h("a", { class: "back-btn", href: "#/cameras", "aria-label": "回到攝影機" }, icon("left")),
      h("div", { class: "live-title" }, title, pill),
      h("div", { class: "page-actions" }, qualityPick, playback),
    ),
    frame.el,
  );
  if (!liveSupported()) root.append(h("p", { class: "live-fallback-note below" }, icon("info", 16), "這個瀏覽器不支援即時影像，畫面每 3 秒更新一次。"));
  return root;
}
