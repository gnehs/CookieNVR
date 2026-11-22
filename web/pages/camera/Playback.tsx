import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyHints } from "../../ui/Kbd.tsx";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CameraDto, EventDto, SegmentDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { errMsg, formatClock, formatDuration } from "../../format.ts";
import { LiveFrame } from "../../live/LiveFrame.tsx";
import type { Quality } from "../../live/transport.ts";
import { Player, type PlayerSource, type PlayerStatus } from "../../playback/player.ts";
import { EVENT_PREROLL_MS, eventAt, labelText, nextEvent, playableFrom, prevEvent, segEnd } from "../../timeline/model.ts";
import { Timeline } from "../../timeline/timeline.ts";
import { Button } from "../../ui/Button.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { DatePicker } from "../../ui/DatePicker.tsx";
import { dayOf, type DayKey } from "../../ui/date-logic.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Select } from "../../ui/Select.tsx";
import { EmptyState } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { useMedia } from "../../ui/useMedia.ts";
import { LiveChip, LivePill, toggleFullscreen, useLiveVideo } from "./live.tsx";
import { dayLabel, dayRange, todayKey } from "./day.ts";
import { ExportButton, ExportJobs, ExportPick, useExport } from "./export.tsx";
import { PtzPanel } from "./PtzPanel.tsx";
import { dayEventsQuery, daysQuery, recordingsQuery, sortSegs } from "./queries.ts";
import type { View } from "./search.ts";

const route = getRouteApi("/_authed/_shell/cameras/$id");

const HOUR = 3_600_000;
const ZOOMS: { value: string; label: MessageDescriptor }[] = [
  { value: String(24 * HOUR), label: msg`24 hours` },
  { value: String(6 * HOUR), label: msg`6 hours` },
  { value: String(HOUR), label: msg`1 hour` },
  { value: String(600_000), label: msg`10 minutes` },
];
const RATES = [1, 2, 4, 8, 16];
/** The newest point playback can start from sits this far behind the newest recording, so the indexer's lag never starves playback. */
const LIVE_LAG_MS = 30_000;
/** 快轉中追到錄製中的片段、距離現在不到這麼久時，改回即時畫面 */
const CATCH_UP_MS = 10_000;
const DAY_POLL_MS = 10_000;
/** 播放位置寫回網址（replace）的最短間隔，暫停與跳轉時立刻寫 */
const URL_WRITE_MS = 5_000;
const NARROW = "(max-width: 760px)";

/** 換到一天之後要不要跳過去：default 是那天第一段（今天是最新），none 是播放自己跨過午夜 */
type Intent = "default" | "none" | { at: number; dir: 1 | -1; play: boolean };

export interface PlaybackProps {
  cam: CameraDto;
  /** 有錄影的日子，由舊到新，至少一天 */
  days: DayKey[];
  view: View;
  quality: Quality;
  admin: boolean;
}

/**
 * 單台頁的畫面、事件清單與時間軸。即時是時間軸的右端：即時時放即時影像、播放頭跟著現在走；
 * 點時間軸、事件或往回跳就換成錄影。Player 與 Timeline 是命令式物件，掛載時各建立一次；
 * 換模式、日期、縮放與資料更新都呼叫它們的方法，不重建，播放位置與緩衝才不會丟。
 */
export function Playback({ cam, days, view, quality, admin }: PlaybackProps) {
  const { t, i18n } = useLingui();
  const camName = cam.config.name;
  const enabled = cam.config.enabled;
  const rateEntries = RATES.map((r) => ({ value: String(r), label: `${r}×`, desc: r === 1 ? t`Normal speed` : undefined }));
  const zoomOptions = ZOOMS.map((z) => ({ value: z.value, label: i18n._(z.label) }));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tParam = route.useSearch({ select: (s) => s.t });
  const narrow = useMedia(NARROW);
  const live = view.kind === "live";
  const today = todayKey();
  // 網址上的日子沒有錄影時，退回最近有錄影的一天
  const date = live ? today : view.date === today || days.includes(view.date) ? view.date : days[days.length - 1]!;
  const [start, end] = dayRange(date);
  const isToday = date === today;
  const key = `${date}|${view.kind}`;

  const dayOpts = { placeholderData: keepPreviousData, refetchInterval: isToday ? DAY_POLL_MS : (false as const) };
  const segQ = useQuery({ ...recordingsQuery(cam.id, start, end), ...dayOpts });
  const evQ = useQuery({ ...dayEventsQuery(cam.id, start, end), ...dayOpts });

  const [status, setStatus] = useState<PlayerStatus>({ kind: "loading" });
  /** 從即時換到錄影、錄影還沒出畫面的這段時間：即時那格留著，上面蓋著最後一張畫面 */
  const [handoff, setHandoff] = useState(false);
  const [clock, setClock] = useState<number | null>(null);
  const [currentEvent, setCurrentEvent] = useState<number | null>(null);
  const [gapNote, setGapNote] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [rate, setRate] = useState(1);
  const [following, setFollowing] = useState(true);
  const [span, setSpan] = useState(() => (matchMedia(NARROW).matches ? 6 * HOUR : 24 * HOUR));
  const [shown, setShown] = useState<{ segs: SegmentDto[]; events: EventDto[] }>({ segs: [], events: [] });
  const [ptzMode, setPtzMode] = useState<"panel" | "note" | undefined>();
  const [ptzSlot, setPtzSlot] = useState<HTMLDivElement | null>(null);
  const count = shown.events.length;
  const liveVideo = useLiveVideo(cam, quality, live);

  const gridRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const tlHostRef = useRef<HTMLDivElement>(null);
  const tl = useRef<Timeline | null>(null);
  const player = useRef<Player | null>(null);
  /** what the imperative callbacks read: the day that is loaded into the timeline, not the one being fetched */
  const st = useRef({
    date,
    live,
    /** PtzPanel 在即時時接管方向鍵 */
    ptz: false,
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
  s.ptz = ptzMode === "panel";

  const wall = () => (s.live ? Date.now() : (player.current?.wall() ?? null));
  const exp = useExport({ timeline: tl, cameraId: cam.id, segments: shown.segs, wall, bounds: [start, end] });

  function latestWall(): number | null {
    const last = s.segs[s.segs.length - 1];
    if (!last) return null;
    return Math.max(last.startMs, segEnd(last, Date.now()) - LIVE_LAG_MS);
  }

  /** 今天、而且比能播的最新一刻還新：那裡就是即時 */
  function atLiveEdge(w: number): boolean {
    if (!enabled || dayOf(w) !== todayKey()) return false;
    const latest = latestWall();
    return latest === null || w > latest;
  }

  function note(text: string) {
    setGapNote(text);
    clearTimeout(s.noteTimer);
    s.noteTimer = setTimeout(() => setGapNote(null), 4_000);
  }

  function seekTo(w: number, dir: 1 | -1 = 1, play = true) {
    const p = player.current;
    if (!p) return;
    const now = Date.now();
    const local = playableFrom(s.segs, w, now, dir);
    const [, dayEnd] = dayRange(s.date);
    // within the loaded day, skip gaps right away so the playhead lands where playback will start
    const target = local && local.wall < dayEnd ? local.wall : w;
    s.seekDir = dir;
    p.seek(Math.min(target, now), play);
    tick();
  }

  /** 即時畫面的最後一格畫到 canvas 上，錄影出畫面之前先看著它，不會黑一下 */
  function leaveLive() {
    const v = liveVideo.video();
    const c = freezeRef.current;
    if (c) {
      const ok = v !== null && v.readyState >= 2 && v.videoWidth > 0 && v.closest('[data-live="on"]') !== null;
      c.width = ok ? v.videoWidth : 0;
      c.height = ok ? v.videoHeight : 0;
      if (ok) c.getContext("2d")?.drawImage(v, 0, 0);
    }
    setHandoff(true);
    s.live = false;
  }

  /** 從即時進回放：多留一筆瀏覽紀錄，按上一頁就回到即時；之後的位置更新都是 replace */
  function enterPlayback(w: number, dir: 1 | -1, play: boolean) {
    const d = dayOf(w);
    leaveLive();
    s.intent = { key: `${d}|playback`, v: { at: w, dir, play } };
    s.urlT = Math.round(w);
    s.urlAt = performance.now();
    void navigate({ to: "/cameras/$id", params: { id: cam.id }, search: { date: d, t: s.urlT }, resetScroll: false });
  }

  function goLive(text?: string) {
    if (text) note(text);
    if (s.live) {
      tl.current?.recenter();
      return;
    }
    void navigate({ to: "/cameras/$id", params: { id: cam.id }, search: {}, replace: true, resetScroll: false });
  }

  /** 時間軸、事件清單、跳到上下一個事件：看那個時間的錄影，今天最新的那端就是即時 */
  function watch(w: number, dir: 1 | -1 = 1) {
    if (atLiveEdge(w)) return goLive();
    if (s.live) enterPlayback(w, dir, true);
    else seekTo(w, dir, true);
  }

  const jumpToEvent = (e: EventDto) => watch(e.startMs - EVENT_PREROLL_MS);

  function seekBy(ms: number) {
    if (s.live) {
      const latest = latestWall();
      if (latest === null) return toast(t`No recordings today yet`, "error");
      return enterPlayback(Math.min(latest, Date.now() + ms), -1, true);
    }
    const w = player.current?.wall() ?? null;
    if (w !== null) watch(w + ms, ms > 0 ? 1 : -1);
  }

  /** 即時時暫停：停在能播的最新一刻，從那裡往回拉 */
  function togglePlay() {
    if (!s.live) return player.current?.toggle();
    const latest = latestWall();
    if (latest === null) return toast(t`No recordings today yet`, "error");
    enterPlayback(latest, 1, false);
  }

  /** 換日期走網址；從即時換過去留一筆瀏覽紀錄，回放中換日期則 replace。載入後依 intent 決定要不要跳 */
  function goDate(d: DayKey, intent: Intent) {
    if (d === todayKey() && intent === "default") return goLive();
    const push = s.live;
    if (push) leaveLive();
    s.intent = { key: `${d}|playback`, v: intent };
    void navigate({ to: "/cameras/$id", params: { id: cam.id }, search: { date: d }, replace: !push, resetScroll: false });
  }

  function writeUrl(w: number, now: number) {
    s.urlAt = now;
    s.urlT = Math.round(w);
    void navigate({ to: "/cameras/$id", params: { id: cam.id }, search: { date: s.date, t: s.urlT }, replace: true, resetScroll: false });
  }

  /** 每一格畫面：時間軸的播放頭；即時時順便每秒更新時鐘與錄影中的那段 */
  function frame() {
    const tline = tl.current;
    if (!tline) return;
    if (!s.live) return tline.setPlayhead(player.current?.wall() ?? null);
    const now = Date.now();
    tline.setPlayhead(now);
    const sec = Math.floor(now / 1000);
    if (sec === s.lastSec) return;
    s.lastSec = sec;
    tline.setData(s.segs, s.events, now);
    setClock(now);
    setCurrentEvent(eventAt(s.events, now, now)?.id ?? null);
  }

  function tick() {
    const p = player.current;
    const video = videoRef.current;
    if (!p || !video || s.live) return;
    const w = p.wall();
    const ts = performance.now();
    tl.current?.setPlayhead(w);
    if (w !== null) {
      const sec = Math.floor(w / 1000);
      if (sec !== s.lastSec) {
        s.lastSec = sec;
        setClock(w);
        setCurrentEvent(eventAt(s.events, w + 1, Date.now())?.id ?? null);
      }
      // fast-forwarding has caught up with what is being recorded: the live picture is what comes next
      if (rate > 1 && p.live && Date.now() - w < CATCH_UP_MS) return goLive(t`Caught up to live`);
      // a forward jump far beyond what the playback rate explains is a skipped gap
      if (s.prevWall !== null && p.state.kind === "playing") {
        const skipped = w - s.prevWall - (ts - s.prevTick) * video.playbackRate;
        if (skipped > 5_000) {
          const gap = formatDuration(skipped);
          note(t`Skipped a ${gap} gap`);
        }
      }
      // until a newly picked day has loaded, the old one is still playing; it must not steer the URL
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

  function onStatus(next: PlayerStatus) {
    setStatus(next);
    if (next.kind !== "loading" && next.kind !== "waiting") setHandoff(false);
    // 今天已經播到最新：接下來就是即時畫面
    if (next.kind === "ended" && !s.live && s.date === todayKey() && enabled) goLive(t`Caught up to live`);
  }

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target instanceof Element ? e.target : document.body;
    // 日期選單、下拉選單與對話框裡的按鍵是它們自己的
    if (el.closest('input, select, textarea, [contenteditable], dialog, [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [role="grid"]')) return;
    if (!player.current) return;
    if (e.key === " ") {
      if (el.closest("button, a, summary")) return;
      togglePlay();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // 即時時能轉的鏡頭由 PtzPanel 接手方向鍵；即時沒有更往後的時間
      if (s.live && (s.ptz || e.key === "ArrowRight")) return;
      const step = e.shiftKey ? 60_000 : 10_000;
      seekBy(e.key === "ArrowLeft" ? -step : step);
    } else if (e.key === "l" || e.key === "L") {
      if (s.live) return;
      goLive();
    } else if (e.key === "[" || e.key === "]") {
      const w = s.live ? (latestWall() ?? Date.now()) : player.current.wall();
      if (w === null) return;
      const ev = e.key === "]" ? nextEvent(s.events, w) : prevEvent(s.events, w);
      if (ev) jumpToEvent(ev);
      else toast(e.key === "]" ? t`No later events` : t`No earlier events`);
    } else return;
    e.preventDefault();
  }

  // the objects below outlive renders; their callbacks reach this render's functions through here
  const fns = useRef({ watch, jumpToEvent, tick, frame, onKey, onStatus, select: exp.select, exportEvent: exp.exportEvent });
  fns.current = { watch, jumpToEvent, tick, frame, onKey, onStatus, select: exp.select, exportEvent: exp.exportEvent };
  const onJump = useCallback((e: EventDto) => fns.current.jumpToEvent(e), []);
  const onExport = useCallback((e: EventDto) => void fns.current.exportEvent(e), []);

  useEffect(() => {
    const video = videoRef.current!;
    const host = tlHostRef.current!;
    const source: PlayerSource = {
      async locate(w) {
        const dir = s.seekDir;
        s.seekDir = 1;
        const list = sortSegs(await api.recordings(cam.id, w - 2 * 60_000, w + 12 * HOUR));
        return playableFrom(list, w, Date.now(), dir);
      },
      async next(seg) {
        const local = s.segs.find((x) => x.startMs > seg.startMs);
        if (local && seg.endMs !== null) return local;
        const list = await api.recordings(cam.id, seg.startMs + 1, seg.startMs + 12 * HOUR);
        return sortSegs(list).find((x) => x.startMs > seg.startMs) ?? null;
      },
      url: (seg) => api.segmentUrl(seg.id),
    };
    const p = new Player(video, source, (next) => fns.current.onStatus(next));
    const tline = new Timeline({
      onSeek: (w, dir) => fns.current.watch(w, dir),
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
    let raf = requestAnimationFrame(function step() {
      raf = requestAnimationFrame(step);
      fns.current.frame();
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

  // 即時時錄影不載入也不播；回放的那個 <video> 留著，之後回到回放時接著用
  useEffect(() => {
    s.live = live;
    if (!live) return;
    player.current?.stop();
    player.current?.setRate(1);
    setRate(1);
    setHandoff(false);
    s.lastSec = -1;
    s.prevWall = null;
  }, [live]);

  useEffect(() => tl.current?.setOrientation(narrow ? "v" : "h"), [narrow]);

  useEffect(() => {
    const panel = panelRef.current!;
    const grid = gridRef.current!;
    const ro = new ResizeObserver(() => grid.style.setProperty("--pb-player-h", `${panel.offsetHeight}px`));
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
    if (!tline || !segs || !events) return;
    s.segs = segs;
    s.events = events;
    tline.setData(segs, events, Date.now());
    setShown({ segs, events });
    if (s.appliedKey === key) return;
    // a new day or mode: until now the old one kept playing
    const newDay = s.appliedKey === "" || s.date !== date;
    s.appliedKey = key;
    s.date = date;
    s.urlT = 0;
    if (newDay) {
      tline.setBounds(start, end);
      exp.reset([start, end]);
    }
    if (live) {
      tline.recenter();
      return;
    }
    const intent: Intent = s.intent.key === key ? s.intent.v : tParam !== undefined ? { at: tParam, dir: 1, play: true } : "default";
    s.intent.key = "";
    if (intent === "none") return;
    const w = typeof intent === "object" ? intent.at : date === todayKey() ? latestWall() : (segs[0]?.startMs ?? null);
    if (w !== null) seekTo(w, typeof intent === "object" ? intent.dir : 1, typeof intent === "object" ? intent.play : true);
    tline.recenter();
    // exp and tParam are read when a new day lands; a change to either alone must not seek again
  }, [segs, events, key]);

  const loadError = segQ.error ?? evQ.error;
  useEffect(() => {
    if (loadError) toast(errMsg(loadError), "error");
  }, [loadError]);

  const wantPlay = player.current?.playing ?? false;
  const playing = live || status.kind === "playing" || ((status.kind === "waiting" || status.kind === "loading") && wantPlay);
  const ago = clock === null ? "" : formatDuration(Date.now() - clock);

  const datePick = (
    // 日曆上標出有錄影的日子，只能選那些天；今天一定選得到，選了就是即時
    <DatePicker
      label={t`Date`}
      value={date}
      min={days[0] ?? null}
      max={today}
      marked={new Set([...days, today])}
      markedLabel={t`Has recordings`}
      onlyMarked
      stepper
      className="pb-date"
      format={(d) => dayLabel(d, narrow)}
      onChange={(d) => d && goDate(d, "default")}
    />
  );

  return (
    <div className="pb-grid" ref={gridRef}>
      <section className="card pb-player" aria-label={t`Player`} ref={panelRef}>
        {/* 手機上日期收進播放器上方，跟播放器一起黏在頂端 */}
        {narrow ? <div className="pb-toolbar">{datePick}</div> : null}
        <div className="pb-stage" ref={stageRef} data-view={live ? "live" : handoff ? "handoff" : "playback"}>
          {live || handoff ? <LiveFrame cam={cam} onTarget={liveVideo.onTarget} className="live-stage" /> : null}
          <video ref={videoRef} playsInline muted aria-label={t`Recording of ${camName}`} />
          <canvas className="pb-freeze" ref={freezeRef} aria-hidden="true" />
          <div className="pb-overlay" role="status" aria-live="polite" data-kind={status.kind}>
            {live ? null : <Overlay status={status} />}
          </div>
          {live ? <LiveChip /> : <span className="pb-chip num">{clock === null ? t`Playback` : t`Playback · ${ago} ago`}</span>}
          <span className="pb-note" role="status" hidden={gapNote === null}>
            {gapNote}
          </span>
          {live ? <div className="ptz-ov" ref={setPtzSlot} /> : null}
        </div>
        {live && enabled ? <PtzPanel cam={cam} admin={admin} onMode={setPtzMode} overlay={ptzSlot} /> : null}
        <div className="pb-controls">
          <button className="pb-ctl" type="button" aria-label={playing ? t`Pause` : t`Play`} onClick={togglePlay}>
            <span>
              <Icon name={playing ? "pause" : "play"} size={20} />
            </span>
          </button>
          <div className="pb-time">
            <b className="pb-clock num">{clock !== null ? formatClock(clock) : "--:--:--"}</b>
            <span className="pb-sub">
              <small>{clock !== null ? dayLabel(dayOf(clock), false, false) : ""}</small>
            </span>
          </div>
          {/* 換行時整組靠右，不會散成左邊一排 */}
          <div className="pb-actions">
            {live ? (
              <LivePill />
            ) : (
              <Button variant="primary" className="pb-golive" icon="skip-end" aria-keyshortcuts="L" onClick={() => goLive()}>
                {t`Back to live`}
              </Button>
            )}
            {live ? null : (
              <>
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
                <button className="pb-ctl" type="button" aria-label={muted ? t`Unmute` : t`Mute`} aria-pressed={!muted} onClick={() => setMuted((m) => !m)}>
                  <span>
                    <Icon name={muted ? "volume-off" : "volume"} size={20} />
                  </span>
                </button>
              </>
            )}
            <button className="pb-ctl" type="button" aria-label={t`Full screen`} onClick={() => toggleFullscreen(stageRef.current, live ? liveVideo.video() : videoRef.current)}>
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
          {narrow ? null : datePick}
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
                { keys: ["L"], label: t`Back to live` },
              ]}
            />
          </div>
          <ExportJobs ui={exp} />
        </div>
      </section>
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
