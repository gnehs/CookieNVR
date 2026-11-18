import type { CameraDto, EventDto, SegmentDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { emptyState, errMsg, formatClock, formatDuration, h, icon, segmented, toast } from "../dom.ts";
import { Player, type PlayerSource, type PlayerStatus } from "../playback/player.ts";
import type { PageCtx } from "../router.ts";
import { browserTz, state } from "../state.ts";
import { EVENT_PREROLL_MS, eventAt, labelText, nextEvent, playableFrom, prevEvent, segEnd } from "../timeline/model.ts";
import { Timeline } from "../timeline/timeline.ts";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");
const HOUR = 3_600_000;

const ZOOMS = [
  { value: String(24 * HOUR), label: "24 小時" },
  { value: String(6 * HOUR), label: "6 小時" },
  { value: String(HOUR), label: "1 小時" },
  { value: String(600_000), label: "10 分鐘" },
];
const RATES = [1, 2, 4, 8, 16];
/** "回到現在" lands this far behind the newest recording, so the indexer's lag never starves playback. */
const LIVE_LAG_MS = 30_000;

function dayRange(date: string): [number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

const dateOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const todayString = () => dateOf(Date.now());

function dayLabel(date: string, short = false): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  const yesterday = dateOf(Date.now() - 86_400_000);
  const rel = date === todayString() ? "今天" : date === yesterday ? "昨天" : "";
  // 手機上的日期選單很窄，今天、昨天只寫一個詞
  if (short && rel) return rel;
  return `${m}/${d} 週${WEEKDAY[dt.getDay()]}${rel ? `（${rel}）` : ""}`;
}

const sortSegs = (list: SegmentDto[]) => list.slice().sort((a, b) => a.startMs - b.startMs);

export async function recordingsPage(ctx: PageCtx): Promise<Node> {
  const cams = await api.cameras();
  if (cams.length === 0) {
    const admin = state.me?.role === "admin";
    return h(
      "div",
      null,
      h("header", { class: "page-head" }, h("h1", null, "錄影")),
      emptyState(
        "還沒有攝影機",
        admin ? "加入攝影機後就會開始錄影，錄好的影片會出現在這裡。" : "請管理員加入攝影機，錄好的影片會出現在這裡。",
        admin ? h("a", { class: "btn primary", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機") : undefined,
        "camera",
      ),
    );
  }

  const wanted = ctx.query.get("camera");
  const cam: CameraDto = cams.find((c) => c.id === wanted) ?? cams[0]!;
  const camSelect = h("select", { "aria-label": "攝影機" }, cams.map((c) => h("option", { value: c.id, selected: c.id === cam.id }, c.config.name)));
  camSelect.addEventListener("change", () => {
    location.hash = `#/recordings?camera=${encodeURIComponent(camSelect.value)}`;
  });
  const camPick = h("div", { class: "cam-pick" }, icon("camera", 18), camSelect);

  let days = (await api.days(cam.id, browserTz())).slice().sort();
  if (days.length === 0) {
    return h(
      "div",
      null,
      h("header", { class: "page-head" }, h("h1", null, "錄影"), camPick),
      emptyState(
        "這台攝影機還沒有錄影",
        !cam.config.enabled ? "這台攝影機已停用。" : cam.config.record.enabled ? "錄影開始後，幾分鐘內就能在這裡回放。" : "這台攝影機沒有開啟全天候錄影。",
        state.me?.role === "admin" && (!cam.config.enabled || !cam.config.record.enabled)
          ? h("a", { class: "btn", href: `#/settings/cameras/${encodeURIComponent(cam.id)}` }, icon("edit", 16), "到攝影機設定開啟")
          : undefined,
      ),
    );
  }
  if (!Player.supported()) {
    return h(
      "div",
      null,
      h("header", { class: "page-head" }, h("h1", null, "錄影"), camPick),
      emptyState("這個瀏覽器無法播放錄影", "iPhone 請更新到 iOS 17.1 以上；也可以改用電腦或 Android 上的 Chrome、Edge、Firefox 或 Safari。", undefined, "alert"),
    );
  }

  const q = ctx.query.get("date");
  let date = q && days.includes(q) ? q : days[days.length - 1]!;
  let segs: SegmentDto[] = [];
  let events: EventDto[] = [];

  const dateSelect = h("select", { "aria-label": "日期" });
  const prevDay = h("button", { class: "btn icon-only", type: "button", "aria-label": "前一天", onclick: () => stepDay(-1) }, icon("left", 18));
  const nextDay = h("button", { class: "btn icon-only", type: "button", "aria-label": "後一天", onclick: () => stepDay(1) }, icon("right", 18));
  dateSelect.addEventListener("change", () => setDate(dateSelect.value, true));
  const renderDays = () => {
    const short = matchMedia("(max-width: 760px)").matches;
    dateSelect.replaceChildren(...days.map((d) => h("option", { value: d, selected: d === date }, dayLabel(d, short))));
    const i = days.indexOf(date);
    prevDay.disabled = i <= 0;
    nextDay.disabled = i < 0 || i >= days.length - 1;
  };

  // 最常用的是換日期與換攝影機，放在標題列；倍速與「回到最新」跟著播放器走
  const rateSelect = h("select", { class: "pb-rate", "aria-label": "播放速度" }, RATES.map((r) => h("option", { value: String(r) }, `${r}×`)));
  rateSelect.addEventListener("change", () => player.setRate(Number(rateSelect.value)));
  const nowBtn = h("button", { class: "pb-ctl pb-ctl-text", type: "button", "aria-label": "回到最新", onclick: () => goLive() }, icon("skip-end", 16), h("span", null, "回到最新"));
  const toolbar = h("div", { class: "pb-toolbar" }, camPick, h("div", { class: "pb-date", role: "group", "aria-label": "日期" }, prevDay, dateSelect, nextDay));

  const video = h("video", { playsinline: true, muted: true, "aria-label": `${cam.config.name} 的錄影` });
  video.muted = true;
  const overlay = h("div", { class: "pb-overlay", role: "status", "aria-live": "polite" });
  const note = h("span", { class: "pb-note", role: "status", hidden: true });
  const stage = h("div", { class: "pb-stage" }, video, overlay, note);
  const playIcon = h("span", null, icon("play", 20));
  const playBtn = h("button", { class: "pb-ctl", type: "button", "aria-label": "播放", onclick: () => player.toggle() }, playIcon);
  const clock = h("b", { class: "pb-clock num" }, "--:--:--");
  const clockDate = h("small", null, "");
  const liveBadge = h("span", { class: "badge live", hidden: true }, "錄製中");
  const muteIcon = h("span", null, icon("volume-off", 20));
  const muteBtn = h("button", { class: "pb-ctl", type: "button", "aria-label": "開啟聲音", "aria-pressed": "false", onclick: () => toggleMute() }, muteIcon);
  const fsBtn = h("button", { class: "pb-ctl", type: "button", "aria-label": "全螢幕", onclick: () => fullscreen() }, icon("expand", 18));
  const controls = h(
    "div",
    { class: "pb-controls" },
    playBtn,
    // 錄製中時，時間下面那行換成「錄製中」，日期已經在上面的日期選單裡
    h("div", { class: "pb-time" }, clock, h("span", { class: "pb-sub" }, clockDate, liveBadge)),
    // 換行時整組靠右，不會散成左邊一排
    h("div", { class: "pb-actions" }, nowBtn, rateSelect, muteBtn, fsBtn),
  );
  const playerPanel = h("section", { class: "card pb-player", "aria-label": "播放器" }, stage, controls);

  function toggleMute() {
    video.muted = !video.muted;
    muteBtn.setAttribute("aria-pressed", String(!video.muted));
    muteBtn.setAttribute("aria-label", video.muted ? "開啟聲音" : "靜音");
    muteIcon.replaceChildren(icon(video.muted ? "volume-off" : "volume", 20));
  }

  function fullscreen() {
    const v = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (stage.requestFullscreen) void stage.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.();
  }

  function showStatus(s: PlayerStatus) {
    const playing = s.kind === "playing" || (s.kind === "waiting" && player.playing) || (s.kind === "loading" && player.playing);
    playBtn.setAttribute("aria-label", playing ? "暫停" : "播放");
    playIcon.replaceChildren(icon(playing ? "pause" : "play", 20));
    overlay.dataset.kind = s.kind;
    if (s.kind === "loading" || s.kind === "waiting") {
      overlay.replaceChildren(h("span", { class: "loading" }, h("span", { class: "spin" }), s.kind === "loading" ? "載入中" : "緩衝中"));
    } else if (s.kind === "ended") {
      overlay.replaceChildren(h("span", { class: "pb-msg" }, "已經播到最新的錄影"));
    } else if (s.kind === "error") {
      overlay.replaceChildren(h("div", { class: "callout bad" }, icon("alert"), h("p", null, s.message)));
    } else {
      overlay.replaceChildren();
    }
  }

  let seekDir: 1 | -1 = 1;
  const source: PlayerSource = {
    async locate(w) {
      const dir = seekDir;
      seekDir = 1;
      const list = sortSegs(await api.recordings(cam.id, w - 2 * 60_000, w + 12 * HOUR));
      return playableFrom(list, w, Date.now(), dir);
    },
    async next(seg) {
      const local = segs.find((s) => s.startMs > seg.startMs);
      if (local && seg.endMs !== null) return local;
      const list = await api.recordings(cam.id, seg.startMs + 1, seg.startMs + 12 * HOUR);
      return sortSegs(list).find((s) => s.startMs > seg.startMs) ?? null;
    },
    url: (seg) => api.segmentUrl(seg.id),
  };
  const player = new Player(video, source, showStatus);

  const followBtn = h("button", { class: "btn small", type: "button", hidden: true, onclick: () => timeline.recenter() }, icon("crosshair", 16), "回到播放位置");
  const zoomCtl = segmented("時間軸範圍", ZOOMS, String(24 * HOUR), (v) => timeline.setSpan(Number(v)));
  const zoomInputs = [...zoomCtl.querySelectorAll("input")];
  const timeline = new Timeline({
    onSeek: (w, dir) => seekTo(w, dir),
    onEvent: (e) => jumpToEvent(e),
    onFollow: (f) => (followBtn.hidden = f),
    onSpan: (ms) => {
      for (const input of zoomInputs) input.checked = Number(input.value) === ms;
    },
    thumbUrl: (e) => api.eventThumbUrl(e.id),
  });
  const kbdHint = h("p", { class: "pb-legend-keys hint", id: "tl-keys" }, "空白鍵播放／暫停・← → 前後 10 秒・[ ] 上／下一個事件");
  timeline.el.setAttribute("aria-describedby", "tl-keys");
  const legend = h(
    "div",
    { class: "pb-legend" },
    h("span", null, h("i", { class: "sw rec" }), "錄影"),
    h("span", null, h("i", { class: "sw live" }), "錄製中"),
    h("span", null, h("i", { class: "sw gap" }), "缺片"),
    h("span", null, h("i", { class: "sw ev" }), "事件"),
    kbdHint,
  );
  const tlPanel = h(
    "section",
    { class: "panel pb-timeline" },
    h("div", { class: "panel-head" }, h("h2", null, "時間軸"), followBtn, zoomCtl),
    h("div", { class: "panel-body" }, timeline.el, legend),
  );

  const evCount = h("span", { class: "hint" });
  const evList = h("ol", { class: "ev-list", "aria-label": "事件清單" });
  const evPanel = h("section", { class: "panel pb-events" }, h("div", { class: "panel-head" }, h("h2", null, "事件"), evCount), h("div", { class: "panel-body" }, evList));
  const evButtons = new Map<number, HTMLButtonElement>();
  let currentEvent: number | null = null;

  function renderEvents() {
    evButtons.clear();
    currentEvent = null;
    evCount.textContent = events.length ? `${events.length} 筆` : "";
    if (events.length === 0) {
      evList.replaceChildren(h("li", { class: "ev-empty" }, emptyState("這一天沒有事件", "開啟動作偵測後，偵測到的事件會出現在這裡。", undefined, "activity")));
      return;
    }
    evList.replaceChildren(
      ...events.map((e) => {
        const dur = e.endMs === null ? `已持續 ${formatDuration(Date.now() - e.startMs)}` : formatDuration(e.endMs - e.startMs);
        const btn = h(
          "button",
          { type: "button", class: "ev-item", "aria-label": `${formatClock(e.startMs)}，${labelText(e.labels)}，${e.endMs === null ? "進行中" : dur}`, onclick: () => jumpToEvent(e) },
          h("span", { class: "ev-thumb" }, e.hasThumb ? h("img", { src: api.eventThumbUrl(e.id), alt: "", loading: "lazy", decoding: "async", width: "96", height: "54" }) : icon("activity", 18)),
          h("span", { class: "ev-text" }, h("b", null, labelText(e.labels)), h("span", { class: "num" }, formatClock(e.startMs), " · ", dur)),
          e.endMs === null ? h("span", { class: "badge accent live" }, "進行中") : null,
        );
        evButtons.set(e.id, btn);
        return h("li", null, btn);
      }),
    );
  }

  function markCurrentEvent(wall: number | null) {
    const e = wall === null ? null : eventAt(events, wall + 1, Date.now());
    const id = e?.id ?? null;
    if (id === currentEvent) return;
    if (currentEvent !== null) evButtons.get(currentEvent)?.removeAttribute("aria-current");
    currentEvent = id;
    const btn = id !== null ? evButtons.get(id) : undefined;
    if (btn) {
      btn.setAttribute("aria-current", "true");
      // scroll the list only; scrollIntoView would also move the page under the reader's thumb
      const item = btn.offsetTop;
      if (item < evList.scrollTop || item + btn.offsetHeight > evList.scrollTop + evList.clientHeight) {
        evList.scrollTo({ top: item - evList.clientHeight / 2 + btn.offsetHeight / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    }
  }

  function seekTo(w: number, dir: 1 | -1 = 1, play = true) {
    const now = Date.now();
    const local = playableFrom(segs, w, now, dir);
    const [, dayEnd] = dayRange(date);
    // within the loaded day, skip gaps right away so the playhead lands where playback will start
    const target = local && local.wall < dayEnd ? local.wall : w;
    seekDir = dir;
    player.seek(Math.min(target, now), play);
    tick();
  }

  function jumpToEvent(e: EventDto) {
    seekTo(e.startMs - EVENT_PREROLL_MS, 1, true);
  }

  function seekBy(ms: number) {
    const w = player.wall();
    if (w !== null) seekTo(w + ms, ms > 0 ? 1 : -1);
  }

  function latestWall(): number | null {
    const last = segs[segs.length - 1];
    if (!last) return null;
    return Math.max(last.startMs, segEnd(last, Date.now()) - LIVE_LAG_MS);
  }

  async function goLive() {
    const today = todayString();
    if (date !== today) {
      if (!days.includes(today)) days = (await api.days(cam.id, browserTz())).slice().sort();
      if (!days.includes(today)) return toast("今天還沒有錄影", "error");
      await setDate(today, false);
    }
    const w = latestWall();
    if (w !== null) seekTo(w, 1, true);
    timeline.recenter();
  }

  function stepDay(d: 1 | -1) {
    const i = days.indexOf(date) + d;
    const next = days[i];
    if (next) void setDate(next, true);
  }

  let loadToken = 0;
  async function loadDay() {
    const token = ++loadToken;
    const [start, end] = dayRange(date);
    const [s, e] = await Promise.all([api.recordings(cam.id, start, end), api.events(cam.id, start, end)]);
    if (token !== loadToken || !ctx.isCurrent()) return false;
    segs = sortSegs(s);
    events = e.slice().sort((a, b) => a.startMs - b.startMs);
    timeline.setData(segs, events, Date.now());
    renderEvents();
    return true;
  }

  async function setDate(d: string, seek: boolean) {
    date = d;
    renderDays();
    history.replaceState(null, "", `#/recordings?camera=${encodeURIComponent(cam.id)}&date=${d}`);
    const [start, end] = dayRange(d);
    timeline.setBounds(start, end);
    try {
      if (!(await loadDay())) return;
    } catch (e) {
      toast(errMsg(e), "error");
      return;
    }
    if (seek) {
      const w = d === todayString() ? latestWall() : (segs[0]?.startMs ?? null);
      if (w !== null) seekTo(w, 1, true);
      timeline.recenter();
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !ctx.isCurrent()) return;
    const t = e.target instanceof Element ? e.target : document.body;
    if (t.closest("input, select, textarea, [contenteditable], dialog")) return;
    if (e.key === " ") {
      if (t.closest("button, a, summary")) return;
      player.toggle();
    } else if (e.key === "ArrowLeft") seekBy(e.shiftKey ? -60_000 : -10_000);
    else if (e.key === "ArrowRight") seekBy(e.shiftKey ? 60_000 : 10_000);
    else if (e.key === "[" || e.key === "]") {
      const w = player.wall();
      if (w === null) return;
      const ev = e.key === "]" ? nextEvent(events, w) : prevEvent(events, w);
      if (ev) jumpToEvent(ev);
      else toast(e.key === "]" ? "後面沒有事件了" : "前面沒有事件了");
    } else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  let lastShownSec = -1;
  let prevWall: number | null = null;
  let prevTick = performance.now();
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    timeline.setPlayhead(player.wall());
  };
  const tick = () => {
    const w = player.wall();
    const t = performance.now();
    timeline.setPlayhead(w);
    if (w !== null) {
      const sec = Math.floor(w / 1000);
      if (sec !== lastShownSec) {
        lastShownSec = sec;
        clock.textContent = formatClock(w);
        clockDate.textContent = dayLabel(dateOf(w)).replace(/（.*）/, "");
        liveBadge.hidden = !player.live;
        clockDate.hidden = player.live;
        markCurrentEvent(w);
      }
      // a forward jump far beyond what the playback rate explains is a skipped gap
      if (prevWall !== null && player.state.kind === "playing") {
        const expected = (t - prevTick) * video.playbackRate;
        const skipped = w - prevWall - expected;
        if (skipped > 5_000) {
          note.textContent = `跳過 ${formatDuration(skipped)} 缺片`;
          note.hidden = false;
          clearTimeout(noteTimer);
          noteTimer = setTimeout(() => (note.hidden = true), 4_000);
        }
      }
      const [dayStart, dayEnd] = dayRange(date);
      if ((w >= dayEnd || w < dayStart) && player.state.kind === "playing") {
        const d = dateOf(w);
        if (!days.includes(d)) days = [...days, d].sort();
        void setDate(d, false);
      }
    }
    prevWall = w;
    prevTick = t;
  };
  for (const type of ["timeupdate", "seeked", "playing", "pause"]) video.addEventListener(type, tick);

  const head = h("header", { class: "page-head pb-head" }, h("h1", null, "錄影"), toolbar);
  const narrow = matchMedia("(max-width: 760px)");
  // 手機上攝影機與日期收進播放器上方，跟播放器一起黏在頂端
  const applyOrient = () => {
    timeline.setOrientation(narrow.matches ? "v" : "h");
    if (narrow.matches) playerPanel.prepend(toolbar);
    else head.append(toolbar);
    renderDays();
  };
  narrow.addEventListener("change", applyOrient);
  applyOrient();
  // a whole day on a phone-height strip leaves room for only a few event cards
  const initialSpan = narrow.matches ? 6 * HOUR : 24 * HOUR;
  for (const input of zoomInputs) input.checked = Number(input.value) === initialSpan;
  const playerRo = new ResizeObserver(() => root.style.setProperty("--pb-player-h", `${playerPanel.offsetHeight}px`));
  playerRo.observe(playerPanel);

  ctx.every(10_000, async () => {
    if (date !== todayString()) return;
    try {
      await loadDay();
    } catch {}
  });
  ctx.onCleanup(() => {
    cancelAnimationFrame(raf);
    clearTimeout(noteTimer);
    document.removeEventListener("keydown", onKey);
    narrow.removeEventListener("change", applyOrient);
    playerRo.disconnect();
    timeline.destroy();
    player.destroy();
  });

  const root = h("div", { class: "pb" }, head, h("div", { class: "pb-grid" }, playerPanel, evPanel, tlPanel));

  renderDays();
  const [start, end] = dayRange(date);
  timeline.setBounds(start, end);
  timeline.setSpan(initialSpan);
  await loadDay();
  const t = Number(ctx.query.get("t"));
  const initial = Number.isFinite(t) && t > 0 ? t : date === todayString() ? latestWall() : (segs[0]?.startMs ?? null);
  if (initial !== null) seekTo(initial, 1, true);
  showStatus(player.state);
  raf = requestAnimationFrame(frame);
  return root;
}
