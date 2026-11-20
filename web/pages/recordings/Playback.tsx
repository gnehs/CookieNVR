import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyHints } from "../../ui/Kbd.tsx";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CameraDto, EventDto, SegmentDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { errMsg, formatClock, formatDuration } from "../../format.ts";
import { Player, type PlayerSource, type PlayerStatus } from "../../playback/player.ts";
import { EVENT_PREROLL_MS, eventAt, labelText, nextEvent, playableFrom, prevEvent, segEnd } from "../../timeline/model.ts";
import { Timeline } from "../../timeline/timeline.ts";
import { Segmented } from "../../ui/controls.tsx";
import { DatePicker } from "../../ui/DatePicker.tsx";
import { dayOf, type DayKey } from "../../ui/date-logic.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Select } from "../../ui/Select.tsx";
import { EmptyState } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { useMedia } from "../../ui/useMedia.ts";
import { dayLabel, dayRange, todayKey } from "./day.ts";
import { ExportButton, ExportJobs, ExportPick, useExport } from "./export.tsx";
import { dayEventsQuery, daysQuery, recordingsQuery, sortSegs } from "./queries.ts";

const route = getRouteApi("/_authed/_shell/recordings");

const HOUR = 3_600_000;
const ZOOMS: { value: string; label: MessageDescriptor }[] = [
  { value: String(24 * HOUR), label: msg`24 hours` },
  { value: String(6 * HOUR), label: msg`6 hours` },
  { value: String(HOUR), label: msg`1 hour` },
  { value: String(600_000), label: msg`10 minutes` },
];
const RATES = [1, 2, 4, 8, 16];
/** "回到現在" lands this far behind the newest recording, so the indexer's lag never starves playback. */
const LIVE_LAG_MS = 30_000;
/** 快轉中追到錄製中的片段、距離現在不到這麼久時，改回 1 倍速 */
const CATCH_UP_MS = 10_000;
const DAY_POLL_MS = 10_000;
/** 播放位置寫回網址（replace）的最短間隔，暫停與跳轉時立刻寫 */
const URL_WRITE_MS = 5_000;
const NARROW = "(max-width: 760px)";

/** 換到一天之後要不要跳過去：default 是今天跳到最新、其他日子跳到第一段，none 是播放自己跨過午夜 */
type Intent = "default" | "none" | number;

export interface PlaybackProps {
  cam: CameraDto;
  days: DayKey[];
  /** false while the days shown still belong to the previous camera */
  daysReady: boolean;
  date: DayKey;
  /** the camera picker, placed by this component: in the header on wide screens, above the player on phones */
  camPick: ReactNode;
}

/**
 * 回放：播放器、事件清單與時間軸。Player 與 Timeline 是命令式物件，掛載時各建立一次；
 * 換攝影機、日期、縮放與資料更新都呼叫它們的方法，不重建，播放位置與緩衝才不會丟。
 */
export function Playback({ cam, days, daysReady, date, camPick }: PlaybackProps) {
  const { t, i18n } = useLingui();
  const camName = cam.config.name;
  const rateEntries = RATES.map((r) => ({ value: String(r), label: `${r}×`, desc: r === 1 ? t`Normal speed` : undefined }));
  const zoomOptions = ZOOMS.map((z) => ({ value: z.value, label: i18n._(z.label) }));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tParam = route.useSearch({ select: (s) => s.t });
  const narrow = useMedia(NARROW);
  const [start, end] = dayRange(date);
  const isToday = date === todayKey();
  const key = `${cam.id}|${date}`;

  const dayOpts = { enabled: daysReady, placeholderData: keepPreviousData, refetchInterval: isToday ? DAY_POLL_MS : (false as const) };
  const segQ = useQuery({ ...recordingsQuery(cam.id, start, end), ...dayOpts });
  const evQ = useQuery({ ...dayEventsQuery(cam.id, start, end), ...dayOpts });

  const [status, setStatus] = useState<PlayerStatus>({ kind: "loading" });
  const [clock, setClock] = useState<{ wall: number; live: boolean } | null>(null);
  const [currentEvent, setCurrentEvent] = useState<number | null>(null);
  const [gapNote, setGapNote] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [rate, setRate] = useState(1);
  const [following, setFollowing] = useState(true);
  const [span, setSpan] = useState(() => (matchMedia(NARROW).matches ? 6 * HOUR : 24 * HOUR));
  const [shown, setShown] = useState<{ segs: SegmentDto[]; events: EventDto[] }>({ segs: [], events: [] });
  const count = shown.events.length;

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const tlHostRef = useRef<HTMLDivElement>(null);
  const tl = useRef<Timeline | null>(null);
  const player = useRef<Player | null>(null);
  /** what the imperative callbacks read: the day that is loaded into the timeline, not the one being fetched */
  const st = useRef({
    camId: cam.id,
    date,
    segs: [] as SegmentDto[],
    events: [] as EventDto[],
    appliedKey: "",
    intent: { key: "", v: "default" as Intent },
    seekDir: 1 as 1 | -1,
    lastSec: -1,
    prevWall: null as number | null,
    prevTick: 0,
    noteTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    urlAt: 0,
    urlT: 0,
  });
  const s = st.current;

  const exp = useExport({ timeline: tl, cameraId: cam.id, segments: shown.segs, wall: () => player.current?.wall() ?? null, bounds: [start, end] });

  function latestWall(): number | null {
    const last = s.segs[s.segs.length - 1];
    if (!last) return null;
    return Math.max(last.startMs, segEnd(last, Date.now()) - LIVE_LAG_MS);
  }

  function seekTo(w: number, dir: 1 | -1 = 1, play = true, fresh = false) {
    const p = player.current;
    if (!p) return;
    const now = Date.now();
    const local = playableFrom(s.segs, w, now, dir);
    const [, dayEnd] = dayRange(s.date);
    // within the loaded day, skip gaps right away so the playhead lands where playback will start
    const target = local && local.wall < dayEnd ? local.wall : w;
    s.seekDir = dir;
    p.seek(Math.min(target, now), play, fresh);
    tick();
  }

  const jumpToEvent = (e: EventDto) => seekTo(e.startMs - EVENT_PREROLL_MS, 1, true);

  function seekBy(ms: number) {
    const w = player.current?.wall() ?? null;
    if (w !== null) seekTo(w + ms, ms > 0 ? 1 : -1);
  }

  /** 換日期走網址（replace，跟舊版一樣不留歷史紀錄）；載入後依 intent 決定要不要跳 */
  function goDate(d: DayKey, intent: Intent) {
    s.intent = { key: `${cam.id}|${d}`, v: intent };
    void navigate({ to: "/recordings", search: { camera: cam.id, date: d }, replace: true, resetScroll: false });
  }

  async function goLive() {
    const today = todayKey();
    if (s.date !== today) {
      let list = days;
      if (!list.includes(today)) list = await qc.fetchQuery({ ...daysQuery(cam.id), staleTime: 0 });
      if (!list.includes(today)) return toast(t`No recordings today yet`, "error");
      goDate(today, "default");
      return;
    }
    const w = latestWall();
    if (w !== null) seekTo(w, 1, true);
    tl.current?.recenter();
  }

  function writeUrl(w: number, now: number) {
    s.urlAt = now;
    s.urlT = Math.round(w);
    void navigate({ to: "/recordings", search: { camera: s.camId, date: s.date, t: s.urlT }, replace: true, resetScroll: false });
  }

  function tick() {
    const p = player.current;
    const video = videoRef.current;
    if (!p || !video) return;
    const w = p.wall();
    const ts = performance.now();
    tl.current?.setPlayhead(w);
    if (w !== null) {
      const sec = Math.floor(w / 1000);
      if (sec !== s.lastSec) {
        s.lastSec = sec;
        setClock({ wall: w, live: p.live });
        setCurrentEvent(eventAt(s.events, w + 1, Date.now())?.id ?? null);
      }
      // fast-forwarding has caught up with what is being recorded: back to real time
      if (rate > 1 && p.live && Date.now() - w < CATCH_UP_MS) {
        setRate(1);
        p.setRate(1);
        setGapNote(t`Caught up to live, back to 1× speed`);
        clearTimeout(s.noteTimer);
        s.noteTimer = setTimeout(() => setGapNote(null), 4_000);
      }
      // a forward jump far beyond what the playback rate explains is a skipped gap
      if (s.prevWall !== null && p.state.kind === "playing") {
        const skipped = w - s.prevWall - (ts - s.prevTick) * video.playbackRate;
        if (skipped > 5_000) {
          const gap = formatDuration(skipped);
          setGapNote(t`Skipped a ${gap} gap`);
          clearTimeout(s.noteTimer);
          s.noteTimer = setTimeout(() => setGapNote(null), 4_000);
        }
      }
      // until a newly picked camera or day has loaded, the old one is still playing; it must not steer the URL
      const [dayStart, dayEnd] = dayRange(s.date);
      const loaded = s.appliedKey === key;
      if (loaded && (w >= dayEnd || w < dayStart) && p.state.kind === "playing") {
        const d = dayOf(w);
        qc.setQueryData(daysQuery(cam.id).queryKey, (list) => (list && !list.includes(d) ? [...list, d].sort() : list));
        goDate(d, "none");
      } else if (loaded && Math.abs(w - s.urlT) >= 1000 && (ts - s.urlAt >= URL_WRITE_MS || p.state.kind !== "playing")) {
        writeUrl(w, ts);
      }
    }
    s.prevWall = w;
    s.prevTick = ts;
  }

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target instanceof Element ? e.target : document.body;
    // 日期選單、下拉選單與對話框裡的按鍵是它們自己的
    if (el.closest('input, select, textarea, [contenteditable], dialog, [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [role="grid"]')) return;
    const p = player.current;
    if (!p) return;
    if (e.key === " ") {
      if (el.closest("button, a, summary")) return;
      p.toggle();
    } else if (e.key === "ArrowLeft") seekBy(e.shiftKey ? -60_000 : -10_000);
    else if (e.key === "ArrowRight") seekBy(e.shiftKey ? 60_000 : 10_000);
    else if (e.key === "[" || e.key === "]") {
      const w = p.wall();
      if (w === null) return;
      const ev = e.key === "]" ? nextEvent(s.events, w) : prevEvent(s.events, w);
      if (ev) jumpToEvent(ev);
      else toast(e.key === "]" ? t`No later events` : t`No earlier events`);
    } else return;
    e.preventDefault();
  }

  // the objects below outlive renders; their callbacks reach this render's functions through here
  const fns = useRef({ seekTo, jumpToEvent, tick, onKey, select: exp.select, exportEvent: exp.exportEvent });
  fns.current = { seekTo, jumpToEvent, tick, onKey, select: exp.select, exportEvent: exp.exportEvent };
  const onJump = useCallback((e: EventDto) => fns.current.jumpToEvent(e), []);
  const onExport = useCallback((e: EventDto) => void fns.current.exportEvent(e), []);

  useEffect(() => {
    const video = videoRef.current!;
    const host = tlHostRef.current!;
    const source: PlayerSource = {
      async locate(w) {
        const dir = s.seekDir;
        s.seekDir = 1;
        const list = sortSegs(await api.recordings(s.camId, w - 2 * 60_000, w + 12 * HOUR));
        return playableFrom(list, w, Date.now(), dir);
      },
      async next(seg) {
        const local = s.segs.find((x) => x.startMs > seg.startMs);
        if (local && seg.endMs !== null) return local;
        const list = await api.recordings(s.camId, seg.startMs + 1, seg.startMs + 12 * HOUR);
        return sortSegs(list).find((x) => x.startMs > seg.startMs) ?? null;
      },
      url: (seg) => api.segmentUrl(seg.id),
    };
    const p = new Player(video, source, setStatus);
    const tline = new Timeline({
      onSeek: (w, dir) => fns.current.seekTo(w, dir),
      onEvent: (e) => fns.current.jumpToEvent(e),
      onFollow: setFollowing,
      onSpan: setSpan,
      thumbUrl: (e) => api.eventThumbUrl(e.id),
      onSelect: (r) => fns.current.select(r),
    });
    tline.el.setAttribute("aria-describedby", "tl-keys");
    host.append(tline.el);
    const [b0, b1] = dayRange(s.date);
    tline.setBounds(b0, b1);
    tline.setSpan(matchMedia(NARROW).matches ? 6 * HOUR : 24 * HOUR);
    player.current = p;
    tl.current = tline;
    setStatus(p.state);

    const onVideo = () => fns.current.tick();
    const types = ["timeupdate", "seeked", "playing", "pause"];
    for (const type of types) video.addEventListener(type, onVideo);
    const onKeyDown = (e: KeyboardEvent) => fns.current.onKey(e);
    document.addEventListener("keydown", onKeyDown);
    let raf = requestAnimationFrame(function frame() {
      raf = requestAnimationFrame(frame);
      tline.setPlayhead(p.wall());
    });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(s.noteTimer);
      document.removeEventListener("keydown", onKeyDown);
      for (const type of types) video.removeEventListener(type, onVideo);
      tline.destroy();
      tline.el.remove();
      p.destroy();
      tl.current = null;
      player.current = null;
      s.appliedKey = "";
      s.lastSec = -1;
      s.prevWall = null;
    };
  }, []);

  useEffect(() => tl.current?.setOrientation(narrow ? "v" : "h"), [narrow]);

  useEffect(() => {
    const panel = panelRef.current!;
    const root = rootRef.current!;
    const ro = new ResizeObserver(() => root.style.setProperty("--pb-player-h", `${panel.offsetHeight}px`));
    ro.observe(panel);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  const segs = segQ.isPlaceholderData ? undefined : segQ.data;
  const events = evQ.isPlaceholderData ? undefined : evQ.data;
  useEffect(() => {
    const tline = tl.current;
    if (!tline || !daysReady || !segs || !events) return;
    s.segs = segs;
    s.events = events;
    tline.setData(segs, events, Date.now());
    setShown({ segs, events });
    if (s.appliedKey === key) return;
    // a new camera or day: until now the old one kept playing
    s.appliedKey = key;
    // another camera covers the same wall times, so what is buffered is the old camera's footage
    const newCamera = s.camId !== cam.id;
    s.camId = cam.id;
    s.date = date;
    s.urlT = 0;
    tline.setBounds(start, end);
    exp.reset([start, end]);
    const intent = s.intent.key === key ? s.intent.v : (tParam ?? "default");
    if (intent === "none") return;
    const w = typeof intent === "number" ? intent : date === todayKey() ? latestWall() : (segs[0]?.startMs ?? null);
    if (w !== null) seekTo(w, 1, true, newCamera);
    tline.recenter();
    // exp and tParam are read when a new day lands; a change to either alone must not seek again
  }, [segs, events, key, daysReady]);

  const loadError = segQ.error ?? evQ.error;
  useEffect(() => {
    if (loadError) toast(errMsg(loadError), "error");
  }, [loadError]);

  function toggleMute() {
    setMuted((m) => !m);
  }

  function fullscreen() {
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const stage = stageRef.current;
    if (!v || !stage) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (stage.requestFullscreen) void stage.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.();
  }

  const wantPlay = player.current?.playing ?? false;
  const playing = status.kind === "playing" || ((status.kind === "waiting" || status.kind === "loading") && wantPlay);

  const toolbar = (
    <div className="pb-toolbar">
      {camPick}
      {/* 日曆上標出有錄影的日子，只能選那些天；前一天、後一天也只會跳到有錄影的日子 */}
      <DatePicker
        label={t`Date`}
        value={date}
        min={days[0] ?? null}
        max={todayKey()}
        marked={new Set(days)}
        markedLabel={t`Has recordings`}
        onlyMarked
        stepper
        className="pb-date"
        format={(d) => dayLabel(d, narrow)}
        onChange={(d) => d && goDate(d, "default")}
      />
    </div>
  );

  return (
    <div className="pb" ref={rootRef}>
      <header className="page-head pb-head">
        <h1>{t`Recordings`}</h1>
        {narrow ? null : toolbar}
      </header>
      <div className="pb-grid">
        <section className="card pb-player" aria-label={t`Player`} ref={panelRef}>
          {/* 手機上攝影機與日期收進播放器上方，跟播放器一起黏在頂端 */}
          {narrow ? toolbar : null}
          <div className="pb-stage" ref={stageRef}>
            <video ref={videoRef} playsInline muted aria-label={t`Recording of ${camName}`} />
            <div className="pb-overlay" role="status" aria-live="polite" data-kind={status.kind}>
              <Overlay status={status} />
            </div>
            <span className="pb-note" role="status" hidden={gapNote === null}>
              {gapNote}
            </span>
          </div>
          <div className="pb-controls">
            <button className="pb-ctl" type="button" aria-label={playing ? t`Pause` : t`Play`} onClick={() => player.current?.toggle()}>
              <span>
                <Icon name={playing ? "pause" : "play"} size={20} />
              </span>
            </button>
            {/* 錄製中時，時間下面那行換成「錄製中」，日期已經在上面的日期選單裡 */}
            <div className="pb-time">
              <b className="pb-clock num">{clock ? formatClock(clock.wall) : "--:--:--"}</b>
              <span className="pb-sub">
                <small hidden={clock?.live}>{clock ? dayLabel(dayOf(clock.wall), false, false) : ""}</small>
                <span className="badge live" hidden={!clock?.live}>
                  {t`Recording now`}
                </span>
              </span>
            </div>
            {/* 換行時整組靠右，不會散成左邊一排 */}
            <div className="pb-actions">
              <button className="pb-ctl pb-ctl-text" type="button" aria-label={t`Back to latest`} onClick={() => void goLive()}>
                <Icon name="skip-end" size={16} />
                <span>{t`Back to latest`}</span>
              </button>
              <Select
                label={t`Playback speed`}
                variant="quiet"
                className="pb-rate"
                entries={rateEntries}
                value={String(rate)}
                onChange={(v) => {
                  setRate(Number(v));
                  player.current?.setRate(Number(v));
                }}
              />
              <button className="pb-ctl" type="button" aria-label={muted ? t`Unmute` : t`Mute`} aria-pressed={!muted} onClick={toggleMute}>
                <span>
                  <Icon name={muted ? "volume-off" : "volume"} size={20} />
                </span>
              </button>
              <button className="pb-ctl" type="button" aria-label={t`Full screen`} onClick={fullscreen}>
                <Icon name="expand" size={18} />
              </button>
            </div>
          </div>
        </section>
        <section className="panel pb-events">
          <div className="panel-head">
            <h2>{t`Events`}</h2>
            <span className="hint">{count ? plural(count, { one: "# event", other: "# events" }) : ""}</span>
          </div>
          <div className="panel-body">
            <EventList events={shown.events} current={currentEvent} onJump={onJump} onExport={onExport} />
          </div>
        </section>
        <section className="panel pb-timeline">
          <div className="panel-head">
            <h2>{t`Timeline`}</h2>
            <button className="btn small" type="button" hidden={following} onClick={() => tl.current?.recenter()}>
              <Icon name="crosshair" size={16} />
              {t`Back to playhead`}
            </button>
            <ExportButton ui={exp} />
            <Segmented
              label={t`Timeline range`}
              options={zoomOptions}
              value={String(span)}
              onChange={(v) => {
                tl.current?.setSpan(Number(v));
                setSpan(Number(v));
              }}
            />
          </div>
          <div className="panel-body">
            <ExportPick ui={exp} />
            <div className="pb-tl-host" ref={tlHostRef} style={{ display: "contents" }} />
            <div className="pb-legend">
              <span>
                <i className="sw rec" />
                {t`Recording`}
              </span>
              <span>
                <i className="sw live" />
                {t`Recording now`}
              </span>
              <span>
                <i className="sw gap" />
                {t`Gap`}
              </span>
              <span>
                <i className="sw ev" />
                {t`Event`}
              </span>
              <KeyHints
                className="pb-legend-keys"
                id="tl-keys"
                hints={[
                  { keys: [t`Space`], label: t`Play / pause` },
                  { keys: ["←", "→"], label: t`Back / forward 10 seconds` },
                  { keys: ["[", "]"], label: t`Previous / next event` },
                ]}
              />
            </div>
            <ExportJobs ui={exp} />
          </div>
        </section>
      </div>
    </div>
  );
}

function Overlay({ status }: { status: PlayerStatus }) {
  const { t } = useLingui();
  if (status.kind === "loading" || status.kind === "waiting")
    return (
      <span className="loading">
        <span className="spin" />
        {t`Loading…`}
      </span>
    );
  if (status.kind === "ended") return <span className="pb-msg">{t`You've reached the latest recording`}</span>;
  if (status.kind === "error")
    return (
      <div className="callout bad">
        <Icon name="alert" />
        <p>{status.message}</p>
      </div>
    );
  return null;
}

/** 每秒的時鐘更新不會重畫清單；只有資料或目前的事件變了才會 */
const EventList = memo(function EventList({ events, current, onJump, onExport }: { events: EventDto[]; current: number | null; onJump: (e: EventDto) => void; onExport: (e: EventDto) => void }) {
  const { t } = useLingui();
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const btn = current === null ? null : list?.querySelector<HTMLElement>(`[data-event="${current}"]`);
    if (!list || !btn) return;
    // scroll the list only; scrollIntoView would also move the page under the reader's thumb
    const item = btn.offsetTop;
    if (item < list.scrollTop || item + btn.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: item - list.clientHeight / 2 + btn.offsetHeight / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [current]);

  return (
    <ol className="ev-list scroll-fade" aria-label={t`Event list`} ref={listRef}>
      {events.length === 0 ? (
        <li className="ev-empty">
          <EmptyState title={t`No events on this day`} body={t`Once motion detection is on, detected events show up here.`} icon="activity" />
        </li>
      ) : (
        events.map((e) => {
          const elapsed = formatDuration((e.endMs ?? Date.now()) - e.startMs);
          const dur = e.endMs === null ? t`Running for ${elapsed}` : elapsed;
          const what = labelText(e.labels);
          const clock = formatClock(e.startMs);
          return (
            <li className="ev-row" key={e.id}>
              <button
                type="button"
                className="ev-item"
                data-event={e.id}
                aria-current={e.id === current ? "true" : undefined}
                aria-label={e.endMs === null ? t`${what} ${clock} · ${dur} · In progress` : t`${what} ${clock} · ${dur}`}
                onClick={() => onJump(e)}
              >
                <span className="ev-thumb">{e.hasThumb ? <img src={api.eventThumbUrl(e.id)} alt="" loading="lazy" decoding="async" width="96" height="54" /> : <Icon name="activity" size={18} />}</span>
                <span className="ev-text">
                  <b>{labelText(e.labels)}</b>
                  <span className="num">
                    {formatClock(e.startMs)} · {dur}
                  </span>
                </span>
                {e.endMs === null ? <span className="badge accent live">{t`In progress`}</span> : null}
              </button>
              <button
                type="button"
                className="btn ghost icon-only ev-export"
                aria-label={t`Export the event video from ${clock}`}
                title={t`Export video (includes 5 seconds before and after)`}
                onClick={() => onExport(e)}
              >
                <Icon name="download" size={16} />
              </button>
            </li>
          );
        })
      )}
    </ol>
  );
});
