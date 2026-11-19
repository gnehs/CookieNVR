import type { CameraDto, EventDto, ObjectLabelsDto } from "../../src/api-types.ts";
import { LABEL_KEY, labelName } from "../../src/objects/labels.ts";
import { api } from "../api.ts";
import { confirmDialog, emptyState, errMsg, errorBox, formatClock, h, icon, menuButton, toast } from "../dom.ts";
import { eventLabelOptions } from "../detect/object-model.ts";
import { dayBounds, dayKey, dayTitle, groupByDay, mergeEvents, playbackHref } from "../detect/model.ts";
import { EVENT_ACTIVE } from "../health.ts";
import type { PageCtx } from "../router.ts";
import { state } from "../state.ts";
import { onStatus } from "../status-stream.ts";
import { labelText } from "../timeline/model.ts";
import { datePicker } from "../ui/date-picker.ts";
import { dayOf, parseDayKey, type DayKey } from "../ui/date-logic.ts";
import { select, type SelectEntry } from "../ui/select.ts";

const PAGE_SIZE = 50;
/** 離底部還有這麼遠就先載下一頁，捲動時不用等 */
const PRELOAD_PX = 900;

interface Filter {
  camera: string | null;
  /** 瀏覽器時區的一天；null 是所有日期 */
  date: DayKey | null;
  /** 物件類別的鍵（見 src/objects/labels.ts）；null 是所有類別 */
  label: string | null;
}

/** 第一頁的狀態；之後的分頁另外記在 more */
type ListState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };
type MoreState = "idle" | "loading" | "error" | "done";

/** 縮圖角落的長度：「0:12」「2:05」 */
function clip(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function spoken(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function writeQuery(f: Filter) {
  const q = new URLSearchParams();
  if (f.camera) q.set("camera", f.camera);
  if (f.date) q.set("date", f.date);
  if (f.label) q.set("label", f.label);
  const qs = q.toString();
  // 換篩選條件不重畫整頁，焦點留在剛操作的控制項上
  history.replaceState(null, "", `#/events${qs ? `?${qs}` : ""}`);
}

export async function eventsPage(ctx: PageCtx): Promise<Node> {
  let cams: CameraDto[] = await api.cameras();
  const admin = state.me?.role === "admin";
  const head = h("header", { class: "page-head ev-head" }, h("h1", null, "事件"));
  if (cams.length === 0) {
    return h(
      "div",
      null,
      head,
      emptyState(
        "還沒有攝影機",
        admin ? "加入攝影機後，偵測到的動作會出現在這裡。" : "請管理員加入攝影機，偵測到的動作會出現在這裡。",
        admin ? h("a", { class: "btn primary", href: "#/settings/cameras/new" }, icon("plus"), "新增攝影機") : undefined,
        "camera",
      ),
    );
  }

  const qCam = ctx.query.get("camera");
  const qDate = ctx.query.get("date");
  const qLabel = ctx.query.get("label");
  const filter: Filter = {
    camera: qCam && cams.some((c) => c.id === qCam) ? qCam : null,
    date: parseDayKey(qDate),
    label: qLabel && LABEL_KEY.test(qLabel) ? qLabel : null,
  };
  const nameOf = (id: string) => cams.find((c) => c.id === id)?.config.name ?? "已刪除的攝影機";

  const camEntries = (): SelectEntry<string>[] => [{ value: "", label: "所有攝影機" }, "separator", ...cams.map((c) => ({ value: c.id, label: c.config.name }))];
  const camSelect = select({ label: "攝影機", icon: "camera", entries: camEntries(), value: filter.camera ?? "", onChange: (v) => setFilter({ ...filter, camera: v || null }) });
  const dates = datePicker({ label: "日期", value: filter.date, clearLabel: "所有日期", max: dayOf(Date.now()), onChange: (date) => setFilter({ ...filter, date }) });
  const ALL_LABELS = { value: "", label: "所有類別" };
  const labelSelect = select({ label: "類別", icon: "tag", entries: [ALL_LABELS], value: filter.label ?? "", onChange: (v) => setFilter({ ...filter, label: v || null }) });
  /** 選項：模型的常用類別與事件裡出現過的（含相機自己的 vehicle、pet）在前，其餘類別在「其他類別」群組；目錄與事件到了就重排 */
  let catalog: ObjectLabelsDto | null = null;
  let optionsKey = "";
  const syncLabelOptions = () => {
    const seen = items.flatMap((e) => e.labels);
    if (filter.label) seen.push(filter.label);
    const { top, rest } = eventLabelOptions(catalog, seen);
    const key = JSON.stringify([top, rest]);
    if (key === optionsKey) return;
    optionsKey = key;
    const opt = (l: { key: string; zh: string }) => ({ value: l.key, label: l.zh });
    const entries: SelectEntry<string>[] = [ALL_LABELS, "separator", ...top.map(opt)];
    if (rest.length) entries.push({ heading: "其他類別", options: rest.map(opt) });
    labelSelect.setEntries(entries);
  };
  void api.objectLabels().then(
    (c) => {
      catalog = c;
      if (ctx.isCurrent()) syncLabelOptions();
    },
    () => {},
  );
  head.append(h("div", { class: "ev-filters" }, camSelect.el, labelSelect.el, dates.el));

  let items: EventDto[] = [];
  let list: ListState = { kind: "loading" };
  let more: MoreState = "idle";
  let cursor = 0;
  let loadToken = 0;
  const cards = new Map<number, { el: HTMLElement; paint: (e: EventDto) => void }>();

  const body = h("div", { class: "ev-body" });
  const sentinel = h("div", { class: "ev-sentinel", "aria-hidden": "true" });
  const foot = h("div", { class: "ev-foot" });

  const bounds = () => (filter.date ? dayBounds(filter.date) : null);
  const matches = (e: EventDto) =>
    (!filter.camera || e.cameraId === filter.camera) && (!filter.date || dayKey(e.startMs) === filter.date) && (!filter.label || e.labels.includes(filter.label));
  /** 還沒有任何事件帶類別（沒用物件辨識、相機也沒回報）就不佔位；篩選中一定要看得到 */
  const syncLabelPick = () => {
    labelSelect.el.hidden = !filter.label && !items.some((e) => e.labels.length > 0);
    syncLabelOptions();
  };

  function card(e0: EventDto): { el: HTMLElement; paint: (e: EventDto) => void } {
    let e = e0;
    const img = e.hasThumb ? h("img", { src: api.eventThumbUrl(e.id), alt: "", loading: "lazy", decoding: "async", width: "320", height: "180" }) : null;
    const chip = h("span", { class: "ev-chip num" });
    const thumb = h("span", { class: "ev-card-thumb" }, img ?? h("span", { class: "cam-ph" }, icon("activity", 22)), chip);
    const time = h("b", { class: "num" });
    const meta = h("span", { class: "ev-card-sub" });
    const tags = h("span", { class: "ev-tags" });
    const link = h("a", { class: "ev-card-link" }, thumb, h("span", { class: "ev-card-text" }, time, meta, tags));
    const actions = admin
      ? menuButton("這筆事件的更多動作", [{ label: "刪除事件", icon: "trash", danger: true, onSelect: () => void remove(e, el) }])
      : null;
    const el = h("li", { class: "ev-card" }, link, actions);
    const paint = (next: EventDto) => {
      e = next;
      const live = e.endMs === null;
      const len = (e.endMs ?? Date.now()) - e.startMs;
      const labels = e.labels.length ? labelText(e.labels) : null;
      link.href = playbackHref(e);
      el.toggleAttribute("data-live", live);
      time.textContent = formatClock(e.startMs);
      meta.textContent = nameOf(e.cameraId);
      tags.hidden = e.labels.length === 0;
      tags.replaceChildren(...[...new Set(e.labels)].map((l) => h("span", { class: "ev-tag" }, labelName(l))));
      chip.textContent = live ? `${EVENT_ACTIVE.badge} ${clip(len)}` : clip(len);
      link.setAttribute("aria-label", `${nameOf(e.cameraId)}，${dayTitle(dayKey(e.startMs), Date.now())} ${formatClock(e.startMs)}${labels ? `，${labels}` : ""}，${live ? `${EVENT_ACTIVE.badge}，已持續 ${spoken(len)}` : `長度 ${spoken(len)}`}，播放錄影`);
    };
    paint(e);
    return { el, paint };
  }

  function cardFor(e: EventDto) {
    let c = cards.get(e.id);
    if (!c) {
      c = card(e);
      cards.set(e.id, c);
    } else c.paint(e);
    return c.el;
  }

  function skeleton() {
    return h(
      "div",
      { class: "ev-day", "aria-busy": "true" },
      h("span", { class: "ev-skel-title" }),
      h("ul", { class: "ev-grid", role: "presentation" }, Array.from({ length: 8 }, () => h("li", { class: "ev-card ev-skel" }, h("span", { class: "ev-card-thumb" }), h("span", { class: "ev-skel-line" }), h("span", { class: "ev-skel-line short" })))),
      h("span", { class: "sr-only", role: "status" }, "載入中…"),
    );
  }

  function empty(): HTMLElement {
    const who = filter.camera ? `「${nameOf(filter.camera)}」` : "";
    const when = filter.date ? dayTitle(filter.date, Date.now()) : "";
    const what = filter.label ? labelName(filter.label) : "";
    const narrowed = [who, when, what].filter(Boolean).length;
    if (narrowed === 0) return emptyState("還沒有事件", "攝影機偵測到動作時，事件會出現在這裡。", undefined, "activity");
    const title = what ? `${who}${when}沒有看到${what}的事件` : when ? `${who}${when}沒有事件` : `${who}還沒有事件`;
    const reset = h("button", { class: "btn", type: "button", onclick: () => resetFilter() }, narrowed > 1 ? "清除篩選" : what ? "看所有類別" : who ? "看所有攝影機" : "看所有日期");
    return emptyState(title, what ? "換個類別或日期看看，或清除篩選。" : when ? "換一天看看，或清除篩選。" : "這台偵測到動作時，事件會出現在這裡。", reset, "activity");
  }

  function render() {
    syncLabelPick();
    if (list.kind === "loading") return body.replaceChildren(skeleton());
    if (list.kind === "error") return body.replaceChildren(errorBox(list.message, () => void reload()));
    if (items.length === 0) {
      cards.clear();
      return body.replaceChildren(empty());
    }
    const now = Date.now();
    const keep = new Set(items.map((e) => e.id));
    for (const id of [...cards.keys()]) if (!keep.has(id)) cards.delete(id);
    body.replaceChildren(
      ...groupByDay(items).map((g) =>
        h("section", { class: "ev-day", "aria-label": dayTitle(g.key, now) }, filter.date ? null : h("h2", { class: "ev-day-title" }, dayTitle(g.key, now)), h("ul", { class: "ev-grid" }, g.events.map(cardFor))),
      ),
    );
    renderFoot();
  }

  function renderFoot() {
    foot.replaceChildren();
    if (list.kind !== "ready" || items.length === 0) return;
    if (more === "loading") foot.append(h("span", { class: "spin" }), h("span", null, "載入更早的事件…"));
    else if (more === "error") foot.append(h("span", null, "更早的事件沒有載入成功"), h("button", { class: "btn small", type: "button", onclick: () => void loadMore() }, icon("refresh", 15), "再試一次"));
    else if (more === "done") foot.append(h("span", null, filter.date ? "這天沒有更早的事件了" : "沒有更早的事件了"));
  }

  /** 抓一頁；有日期篩選時切掉前一天的，切到了就是最後一頁 */
  async function fetchPage(before: number): Promise<{ events: EventDto[]; done: boolean }> {
    const page = await api.eventsBefore(before, PAGE_SIZE, filter.camera, filter.label);
    const b = bounds();
    const inDay = b ? page.filter((e) => e.startMs >= b[0]) : page;
    return { events: inDay, done: page.length < PAGE_SIZE || inDay.length < page.length };
  }

  async function reload() {
    const token = ++loadToken;
    list = { kind: "loading" };
    more = "idle";
    items = [];
    cards.clear();
    render();
    renderFoot();
    const b = bounds();
    try {
      // 剛開始的事件時間可能比瀏覽器時鐘晚一點點，往後多抓一分鐘
      const { events, done } = await fetchPage(b ? b[1] : Date.now() + 60_000);
      if (token !== loadToken || !ctx.isCurrent()) return;
      items = mergeEvents([], events);
      cursor = items.length ? items[items.length - 1]!.startMs + 1 : 0;
      more = done ? "done" : "idle";
      list = { kind: "ready" };
    } catch (e) {
      if (token !== loadToken || !ctx.isCurrent()) return;
      list = { kind: "error", message: errMsg(e) };
    }
    render();
    queueMicrotask(maybeMore);
  }

  async function loadMore() {
    if (list.kind !== "ready" || more === "loading" || more === "done") return;
    const token = loadToken;
    more = "loading";
    renderFoot();
    try {
      const { events, done } = await fetchPage(cursor);
      if (token !== loadToken || !ctx.isCurrent()) return;
      const before = items.length;
      items = mergeEvents(items, events);
      cursor = items.length ? items[items.length - 1]!.startMs + 1 : cursor;
      // 同一毫秒的事件擠滿一整頁時不會前進，直接當作到底，免得一直重抓
      more = done || items.length === before ? "done" : "idle";
      render();
      queueMicrotask(maybeMore);
    } catch {
      if (token !== loadToken) return;
      more = "error";
      renderFoot();
    }
  }

  /** 畫面很高、第一頁就到不了底部時，觀察器不會再觸發，要自己補抓 */
  function maybeMore() {
    if (!ctx.isCurrent() || more !== "idle" || list.kind !== "ready") return;
    if (sentinel.getBoundingClientRect().top < innerHeight + PRELOAD_PX) void loadMore();
  }

  function setFilter(next: Filter) {
    filter.camera = next.camera;
    filter.date = next.date;
    filter.label = next.label;
    camSelect.setValue(next.camera ?? "");
    labelSelect.setValue(next.label ?? "");
    dates.setValue(next.date);
    writeQuery(filter);
    void reload();
  }
  const resetFilter = () => setFilter({ camera: null, date: null, label: null });

  async function remove(e: EventDto, el: HTMLElement) {
    if (e.endMs === null) return toast("事件還在進行中，結束後才能刪除", "error");
    const ok = await confirmDialog("刪除這筆事件？", `${nameOf(e.cameraId)}，${dayTitle(dayKey(e.startMs), Date.now())} ${formatClock(e.startMs)}。事件與縮圖會永久刪除，錄影之後照一般的保留天數清除。`, { confirmLabel: "刪除", danger: true });
    if (!ok) return;
    try {
      await api.deleteEvent(e.id);
    } catch (err) {
      return toast(errMsg(err), "error");
    }
    if (!ctx.isCurrent()) return;
    const drop = () => {
      items = items.filter((x) => x.id !== e.id);
      render();
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) drop();
    else el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.96)" }], { duration: 160, easing: "ease-out" }).finished.then(drop, drop);
    toast("已刪除事件");
  }

  // 進行中的事件跟著狀態推送出現；結束的再抓一次單筆拿到長度
  const refetching = new Set<number>();
  ctx.onCleanup(
    onStatus((s) => {
      const renamed = s.cams.map((c) => c.config.name).join("\n") !== cams.map((c) => c.config.name).join("\n");
      cams = s.cams;
      if (renamed) camSelect.setEntries(camEntries());
      if (list.kind !== "ready") return;
      const fresh = s.events.filter((e) => matches(e) && !items.some((x) => x.id === e.id));
      if (fresh.length) {
        items = mergeEvents(items, fresh);
        render();
      }
      // 進行中的事件類別變了（update）：換成最新的，卡片上的類別標籤跟著更新
      for (const e of s.events) {
        const old = items.find((x) => x.id === e.id);
        if (!old || old.labels.join() === e.labels.join()) continue;
        items = mergeEvents(items, [e]);
        cards.get(e.id)?.paint(e);
      }
      for (const e of items) {
        if (e.endMs !== null || s.events.some((a) => a.id === e.id) || refetching.has(e.id)) continue;
        refetching.add(e.id);
        void api.event(e.id).then(
          (done) => {
            refetching.delete(e.id);
            if (!ctx.isCurrent()) return;
            items = mergeEvents(items, [done]);
            cards.get(done.id)?.paint(done);
          },
          () => refetching.delete(e.id),
        );
      }
    }),
  );
  ctx.every(1000, () => {
    for (const e of items) if (e.endMs === null) cards.get(e.id)?.paint(e);
  });

  const io = new IntersectionObserver((entries) => entries.some((x) => x.isIntersecting) && void loadMore(), { rootMargin: `0px 0px ${PRELOAD_PX}px 0px` });
  io.observe(sentinel);
  ctx.onCleanup(() => io.disconnect());

  void reload();
  return h("div", { class: "ev-page" }, head, body, sentinel, h("div", { class: "ev-foot-wrap", role: "status", "aria-live": "polite" }, foot));
}
