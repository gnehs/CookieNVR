import type { CameraDto, SegmentDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { emptyState, errMsg, errorBox, formatBytes, formatClock, formatDuration, h, icon, nextId, pageHeader, panel, spinner } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { browserTz } from "../state.ts";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");

function dayRange(date: string): [number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

function dateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const todayString = () => dateString(new Date());

function dayLabel(date: string): { top: string; main: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const top = date === todayString() ? "今天" : date === dateString(yesterday) ? "昨天" : `週${WEEKDAY[dt.getDay()]}`;
  return { top, main: `${m}/${d}` };
}

function stepTitle(n: number, text: string): HTMLElement {
  return h("span", { class: "step-title" }, h("span", { class: "step-no", "aria-hidden": "true" }, String(n)), text);
}

export async function recordingsPage(ctx: PageCtx): Promise<Node> {
  const cams = await api.cameras();
  if (cams.length === 0) return h("div", null, pageHeader("錄影"), emptyState("還沒有攝影機", "新增攝影機後，錄影會出現在這裡。", undefined, "camera"));

  const wanted = ctx.query.get("camera");
  const cam: CameraDto = cams.find((c) => c.id === wanted) ?? cams[0]!;

  const camSelect = h("select", { "aria-label": "攝影機" }, cams.map((c) => h("option", { value: c.id, selected: c.id === cam.id }, c.config.name)));
  camSelect.addEventListener("change", () => {
    location.hash = `#/recordings?camera=${encodeURIComponent(camSelect.value)}`;
  });

  const days = (await api.days(cam.id, browserTz())).slice().sort();
  const header = h("header", { class: "page-head" }, h("h1", null, "錄影"), h("div", { class: "cam-pick" }, icon("camera", 18), camSelect));

  if (days.length === 0) {
    return h(
      "div",
      null,
      header,
      emptyState("這台攝影機還沒有錄影", cam.config.record.enabled ? "開始錄影後，片段會顯示在這裡。" : "這台攝影機沒有開啟錄影。"),
    );
  }

  const q = ctx.query.get("date");
  let date = q && days.includes(q) ? q : days[days.length - 1]!;

  const dayName = nextId("day");
  const dayInputs = new Map<string, HTMLInputElement>();
  const dayStrip = h(
    "div",
    { class: "days", role: "radiogroup", "aria-label": "日期" },
    days.map((d) => {
      const { top, main } = dayLabel(d);
      const input = h("input", { type: "radio", name: dayName, value: d, checked: d === date, "aria-label": `${d}（${top}）` });
      input.addEventListener("change", () => input.checked && setDate(d));
      dayInputs.set(d, input);
      return h("label", { class: "day" }, input, h("span", { class: "day-face", "aria-hidden": "true" }, h("small", null, top), h("b", null, main)));
    }),
  );

  const video = h("video", { controls: true, playsinline: true, preload: "metadata" });
  const playerNote = h("div", { class: "player-meta" });
  const playerErr = h("div", { class: "callout warn", hidden: true, role: "alert" }, icon("alert"), h("p", null, "無法播放這個片段。如果它還在錄製中，請稍後再試。"));
  const placeholder = h(
    "div",
    { class: "player-empty" },
    h("span", { class: "step-no", "aria-hidden": "true" }, "3"),
    h("b", null, "選一個片段開始播放"),
    h("span", { class: "hint" }, "播完會自動接續下一段"),
  );
  video.hidden = true;
  playerNote.hidden = true;
  const player = panel({ class: "player", title: h("span", null, cam.config.name) }, placeholder, video, playerErr, playerNote);

  const timeline = h("div", { class: "timeline", role: "group", "aria-label": "時段總覽" });
  const segSummary = h("span", { class: "hint" });
  const listBox = h("div", { class: "seg-scroll" });
  let segs: SegmentDto[] = [];
  let selected: number | null = null;

  const select = (seg: SegmentDto, autoplay = true) => {
    selected = seg.id;
    playerErr.hidden = true;
    placeholder.hidden = true;
    video.hidden = false;
    playerNote.hidden = false;
    video.src = api.segmentUrl(seg.id);
    if (autoplay) video.play().catch(() => {});
    const live = seg.endMs == null;
    playerNote.replaceChildren(
      h("b", null, formatClock(seg.startMs)),
      h("span", null, date),
      h("span", { class: "spacer" }),
      live ? h("span", { class: "badge bad" }, "錄製中") : h("span", null, formatDuration(seg.endMs! - seg.startMs)),
      h("span", null, formatBytes(seg.size)),
    );
    renderList();
  };

  video.addEventListener("error", () => {
    if (selected != null) playerErr.hidden = false;
  });
  video.addEventListener("ended", () => {
    const i = segs.findIndex((s) => s.id === selected);
    const nextSeg = segs[i + 1];
    if (i >= 0 && nextSeg) select(nextSeg);
  });

  const hourSections = new Map<number, HTMLElement>();

  function renderTimeline(byHour: Map<number, SegmentDto[]>) {
    const selHour = segs.find((s) => s.id === selected);
    const cur = selHour ? new Date(selHour.startMs).getHours() : -1;
    timeline.replaceChildren(
      ...Array.from({ length: 24 }, (_, hr) => {
        const items = byHour.get(hr);
        if (!items) return h("span", { "aria-hidden": "true" });
        const live = items.some((s) => s.endMs == null);
        return h("button", {
          type: "button",
          class: `${live ? "has-live" : ""}${hr === cur ? " current" : ""}`,
          title: `${pad(hr)}:00，${items.length} 段`,
          "aria-label": `跳到 ${pad(hr)} 點（${items.length} 段${live ? "，含錄製中" : ""}）`,
          onclick: () => hourSections.get(hr)?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }),
        });
      }),
    );
  }

  function renderList() {
    hourSections.clear();
    if (segs.length === 0) {
      segSummary.textContent = "";
      timeline.replaceChildren();
      listBox.replaceChildren(emptyState("這一天沒有片段"));
      return;
    }
    const byHour = new Map<number, SegmentDto[]>();
    for (const s of segs) {
      const hr = new Date(s.startMs).getHours();
      (byHour.get(hr) ?? byHour.set(hr, []).get(hr)!).push(s);
    }
    renderTimeline(byHour);
    const total = segs.reduce((a, s) => a + s.size, 0);
    segSummary.textContent = `${segs.length} 段・${formatBytes(total)}`;
    listBox.replaceChildren(
      ...[...byHour].map(([hr, items]) => {
        const sec = h(
          "section",
          { class: "hour" },
          h("h4", null, h("b", null, `${pad(hr)}:00`), h("span", null, `${items.length} 段`)),
          h(
            "div",
            { class: "chips" },
            items.map((s) => {
              const live = s.endMs == null;
              return h(
                "button",
                {
                  class: `chip${live ? " live" : ""}`,
                  type: "button",
                  "aria-pressed": String(s.id === selected),
                  "aria-label": `${formatClock(s.startMs)}${live ? "，錄製中" : `，${formatBytes(s.size)}`}`,
                  onclick: () => select(s),
                },
                h("b", null, formatClock(s.startMs)),
                h("small", null, live ? [h("span", { class: "live-dot" }), "錄製中"] : formatBytes(s.size)),
              );
            }),
          ),
        );
        hourSections.set(hr, sec);
        return sec;
      }),
    );
  }

  let loadToken = 0;
  async function loadDay(showSpinner: boolean) {
    const token = ++loadToken;
    if (showSpinner) listBox.replaceChildren(spinner());
    try {
      const [start, end] = dayRange(date);
      const res = await api.recordings(cam.id, start, end);
      if (token !== loadToken || !ctx.isCurrent()) return;
      segs = res.slice().sort((a, b) => a.startMs - b.startMs);
      const keep = listBox.scrollTop;
      renderList();
      // 今天的片段直接停在最新的地方；背景刷新則維持使用者的捲動位置
      if (showSpinner && date === todayString()) listBox.scrollTop = listBox.scrollHeight;
      else if (!showSpinner) listBox.scrollTop = keep;
    } catch (e) {
      if (showSpinner) listBox.replaceChildren(errorBox(errMsg(e), () => void loadDay(true)));
    }
  }

  function setDate(d: string) {
    date = d;
    const input = dayInputs.get(d);
    if (input) input.checked = true;
    selected = null;
    history.replaceState(null, "", `#/recordings?camera=${encodeURIComponent(cam.id)}&date=${d}`);
    void loadDay(true);
  }

  ctx.every(10_000, () => {
    if (date === todayString()) void loadDay(false);
  });
  ctx.onCleanup(() => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  await loadDay(true);

  // 最新的日期在最右邊，進頁時捲到選中的那天
  requestAnimationFrame(() => {
    dayInputs.get(date)?.closest(".day")?.scrollIntoView({ inline: "nearest", block: "nearest" });
    if (date === todayString()) listBox.scrollTop = listBox.scrollHeight;
  });

  const dayPanel = panel({ title: stepTitle(1, "選擇日期"), actions: h("span", { class: "hint" }, `${days.length} 天有錄影`) }, dayStrip);
  const segPanel = panel({ class: "seg-panel", title: stepTitle(2, "選擇片段"), actions: segSummary }, timeline, h("div", { class: "timeline-scale", "aria-hidden": "true" }, ["00", "06", "12", "18"].map((t) => h("span", null, t))), listBox);

  return h("div", null, header, h("div", { class: "rec-top" }, dayPanel), h("div", { class: "rec-layout" }, player, segPanel));
}
