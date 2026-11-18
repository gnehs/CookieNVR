import type { CameraDto, SegmentDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { emptyState, errMsg, errorBox, field, formatBytes, formatClock, formatDuration, h, icon, pageHeader, spinner } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { browserTz } from "../state.ts";

function dayRange(date: string): [number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function recordingsPage(ctx: PageCtx): Promise<Node> {
  const cams = await api.cameras();
  if (cams.length === 0) return h("div", null, pageHeader("錄影"), emptyState("還沒有攝影機", "新增攝影機後，錄影會出現在這裡。"));

  const wanted = ctx.query.get("camera");
  const cam: CameraDto = cams.find((c) => c.id === wanted) ?? cams[0]!;

  const camSelect = h("select", null, cams.map((c) => h("option", { value: c.id, selected: c.id === cam.id }, c.config.name)));
  camSelect.addEventListener("change", () => {
    location.hash = `#/recordings?camera=${encodeURIComponent(camSelect.value)}`;
  });

  const days = (await api.days(cam.id, browserTz())).slice().sort();
  const dateSelect = h("select", { disabled: days.length === 0 });
  const prev = h("button", { class: "btn icon-only", type: "button", "aria-label": "前一天" }, icon("left"));
  const next = h("button", { class: "btn icon-only", type: "button", "aria-label": "後一天" }, icon("right"));
  for (const d of [...days].reverse()) dateSelect.appendChild(h("option", { value: d }, d));

  const header = pageHeader("錄影");
  const bar = h(
    "div",
    { class: "rec-bar" },
    field("攝影機", camSelect),
    h("div", { class: "field" }, h("label", { for: "date-select" }, "日期"), h("div", { class: "date-nav" }, prev, dateSelect, next)),
  );
  dateSelect.id = "date-select";

  if (days.length === 0) {
    return h("div", null, header, bar, emptyState("這台攝影機還沒有錄影", cam.config.record.enabled ? "開始錄影後，片段會顯示在這裡。" : "這台攝影機沒有開啟錄影。"));
  }

  const q = ctx.query.get("date");
  let date = q && days.includes(q) ? q : days[days.length - 1]!;
  dateSelect.value = date;

  const video = h("video", { controls: true, playsinline: true, preload: "metadata" });
  const playerNote = h("div", { class: "player-meta" });
  const playerErr = h("div", { class: "callout warn", hidden: true, role: "alert" }, icon("alert"), h("p", null, "無法播放這個片段。如果它還在錄製中，請稍後再試。"));
  const placeholder = h("div", { class: "player-empty" }, "從右側選一個片段開始播放");
  video.hidden = true;
  const player = h("div", { class: "player" }, placeholder, video, playerErr, playerNote);

  const listBox = h("div", { class: "seg-scroll" });
  let segs: SegmentDto[] = [];
  let selected: number | null = null;

  const select = (seg: SegmentDto, autoplay = true) => {
    selected = seg.id;
    playerErr.hidden = true;
    placeholder.hidden = true;
    video.hidden = false;
    video.src = api.segmentUrl(seg.id);
    if (autoplay) video.play().catch(() => {});
    const dur = seg.endMs ? formatDuration(seg.endMs - seg.startMs) : "錄製中";
    playerNote.replaceChildren(h("span", null, `${date} ${formatClock(seg.startMs)}`), h("span", null, `${dur} · ${formatBytes(seg.size)}`));
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

  function renderList() {
    if (segs.length === 0) {
      listBox.replaceChildren(emptyState("這一天沒有片段"));
      return;
    }
    const byHour = new Map<number, SegmentDto[]>();
    for (const s of segs) {
      const hr = new Date(s.startMs).getHours();
      (byHour.get(hr) ?? byHour.set(hr, []).get(hr)!).push(s);
    }
    const total = segs.reduce((a, s) => a + s.size, 0);
    listBox.replaceChildren(
      h("p", { class: "hint", style: "margin-bottom:10px" }, `${segs.length} 個片段，共 ${formatBytes(total)}`),
      ...[...byHour].map(([hr, items]) =>
        h(
          "section",
          { class: "hour" },
          h("h3", null, h("span", null, `${String(hr).padStart(2, "0")}:00`), h("span", null, `${items.length} 段`)),
          h(
            "div",
            { class: "chips" },
            items.map((s) => {
              const chip = h(
                "button",
                { class: `chip${s.endMs == null ? " live" : ""}`, type: "button", "aria-pressed": String(s.id === selected), onclick: () => select(s) },
                h("b", null, formatClock(s.startMs)),
                h("small", null, s.endMs == null ? "錄製中" : formatBytes(s.size)),
              );
              return chip;
            }),
          ),
        ),
      ),
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
      renderList();
    } catch (e) {
      if (showSpinner) listBox.replaceChildren(errorBox(errMsg(e), () => void loadDay(true)));
    }
  }

  const setDate = (d: string) => {
    date = d;
    dateSelect.value = d;
    selected = null;
    history.replaceState(null, "", `#/recordings?camera=${encodeURIComponent(cam.id)}&date=${d}`);
    syncNav();
    void loadDay(true);
  };
  function syncNav() {
    const i = days.indexOf(date);
    prev.disabled = i <= 0;
    next.disabled = i < 0 || i >= days.length - 1;
  }
  dateSelect.addEventListener("change", () => setDate(dateSelect.value));
  prev.addEventListener("click", () => setDate(days[days.indexOf(date) - 1]!));
  next.addEventListener("click", () => setDate(days[days.indexOf(date) + 1]!));
  syncNav();

  ctx.every(10_000, () => {
    if (date === todayString()) void loadDay(false);
  });
  ctx.onCleanup(() => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  await loadDay(true);

  return h("div", null, header, bar, h("div", { class: "rec-layout" }, player, listBox));
}
