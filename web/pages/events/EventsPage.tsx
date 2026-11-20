import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EventDto } from "../../../src/api-types.ts";
import { labelName } from "../../../src/objects/labels.ts";
import { api } from "../../api.ts";
import { activeEventsQuery, camerasQuery, objectLabelsQuery } from "../../data/queries.ts";
import { useMe } from "../../data/session.ts";
import { dayBounds, dayKey, dayTitle, groupByDay, mergeEvents, playbackSearch } from "../../detect/model.ts";
import { eventLabelOptions } from "../../detect/object-model.ts";
import { errMsg, formatClock } from "../../format.ts";
import { EVENT_ACTIVE } from "../../health.ts";
import { labelText } from "../../timeline/model.ts";
import { Button, ButtonLink } from "../../ui/Button.tsx";
import { DatePicker } from "../../ui/DatePicker.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { dayOf, type DayKey } from "../../ui/date-logic.ts";
import { Icon } from "../../ui/Icon.tsx";
import { MenuButton } from "../../ui/Menu.tsx";
import { MultiSelect, Select, type SelectEntry } from "../../ui/Select.tsx";
import { EmptyState, ErrorBox } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";

const PAGE_SIZE = 50;
/** 離底部還有這麼遠就先載下一頁，捲動時不用等 */
const PRELOAD_PX = 900;

/** 網址上的篩選條件（`routes/_authed/_shell/events.tsx` 的 validateSearch 產生） */
export interface EventsSearch {
  camera?: string;
  /** 瀏覽器時區的一天 */
  date?: DayKey;
  /** 物件類別的鍵（見 src/objects/labels.ts），多個用逗號分隔：含任一類別的事件 */
  label?: string;
}

interface Filter {
  camera: string | null;
  date: DayKey | null;
  /** 空陣列 = 所有類別；排序過，同一組篩選的快取鍵才會一樣 */
  labels: string[];
}

interface Page {
  events: EventDto[];
  /** 下一頁從這個時間之前抓；null 是沒有下一頁 */
  next: number | null;
}

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

const listKey = (f: Filter) => ["events", "list", { camera: f.camera, labels: f.labels.join(","), date: f.date }] as const;

/** 抓一頁；有日期篩選時切掉前一天的，切到了就是最後一頁 */
async function fetchPage(f: Filter, before: number | null): Promise<Page> {
  const b = f.date ? dayBounds(f.date) : null;
  // 剛開始的事件時間可能比瀏覽器時鐘晚一點點，往後多抓一分鐘
  const cursor = before ?? (b ? b[1] : Date.now() + 60_000);
  const page = await api.eventsBefore(cursor, PAGE_SIZE, f.camera, f.labels);
  const inDay = b ? page.filter((e) => e.startMs >= b[0]) : page;
  const done = page.length < PAGE_SIZE || inDay.length < page.length || inDay.length === 0;
  const next = inDay.length ? inDay[inDay.length - 1]!.startMs + 1 : null;
  // 同一毫秒的事件擠滿一整頁時不會前進，直接當作到底，免得一直重抓
  return { events: inDay, next: done || next === null || next >= cursor ? null : next };
}

export function EventsPage() {
  const isAdmin = useMe().role === "admin";
  const cams = useQuery(camerasQuery);
  if (cams.isError) return <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />;
  if (cams.isPending) return <Header />;
  if (cams.data.length === 0) {
    return (
      <div>
        <Header />
        <EmptyState
          icon="camera"
          title="還沒有攝影機"
          body={isAdmin ? "加入攝影機後，偵測到的動作會出現在這裡。" : "請管理員加入攝影機，偵測到的動作會出現在這裡。"}
          action={
            isAdmin ? (
              <ButtonLink to="/settings/cameras/new" variant="primary" icon="plus">
                新增攝影機
              </ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  }
  return <EventsList />;
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="page-head ev-head">
      <h1>事件</h1>
      {children}
    </header>
  );
}

function EventsList() {
  const isAdmin = useMe().role === "admin";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search: EventsSearch = useSearch({ from: "/_authed/_shell/events" });
  const cams = useQuery(camerasQuery).data ?? [];
  const active = useQuery(activeEventsQuery);
  const catalog = useQuery({ ...objectLabelsQuery, retry: false }).data ?? null;

  const filter: Filter = {
    camera: search.camera && cams.some((c) => c.id === search.camera) ? search.camera : null,
    date: search.date ?? null,
    labels: search.label ? search.label.split(",") : [],
  };
  const nameOf = (id: string) => cams.find((c) => c.id === id)?.config.name ?? "已刪除的攝影機";
  const setFilter = (next: Filter) =>
    void navigate({
      to: "/events",
      search: { camera: next.camera ?? undefined, date: next.date ?? undefined, label: next.labels.length ? [...new Set(next.labels)].sort().join(",") : undefined },
      replace: true,
    });
  const resetFilter = () => setFilter({ camera: null, date: null, labels: [] });

  const key = listKey(filter);
  const list = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(filter, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
    // 每次進頁面或換篩選都重抓；開著的時候由狀態推送補上新事件，不用背景重抓整串
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // 結束的事件再抓一次單筆拿到長度；抓回來的放這裡蓋過清單裡的舊資料
  const [patched, setPatched] = useState<ReadonlyMap<number, EventDto>>(new Map());
  const matches = (e: EventDto) =>
    (!filter.camera || e.cameraId === filter.camera) && (!filter.date || dayKey(e.startMs) === filter.date) && (filter.labels.length === 0 || e.labels.some((l) => filter.labels.includes(l)));
  const activeData = active.data;
  const items = useMemo(() => {
    const fromPages = (list.data?.pages ?? []).flatMap((p) => p.events);
    const live = (activeData ?? []).filter(matches);
    const merged = mergeEvents(fromPages, live);
    return patched.size ? merged.map((e) => (e.endMs === null ? (patched.get(e.id) ?? e) : e)) : merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, activeData, patched, filter.camera, filter.date, search.label]);

  const hasLive = items.some((e) => e.endMs === null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLive) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasLive]);

  const refetching = useRef(new Set<number>());
  useEffect(() => {
    if (!list.isSuccess || !activeData) return;
    const activeIds = new Set(activeData.map((e) => e.id));
    for (const e of items) {
      if (e.endMs !== null || activeIds.has(e.id) || refetching.current.has(e.id)) continue;
      const id = e.id;
      refetching.current.add(id);
      void api.event(id).then(
        (done) => {
          if (done.endMs !== null) setPatched((m) => new Map(m).set(id, done));
          // 還沒結束就稍後再試，免得一直重抓
          setTimeout(() => refetching.current.delete(id), done.endMs !== null ? 0 : 2000);
        },
        () => refetching.current.delete(id),
      );
    }
  }, [items, activeData, list.isSuccess, now]);

  // 次數只在沒篩類別時更新：篩選中的清單只剩勾到的類別，拿來排序會讓選項在勾選的當下跳來跳去
  const freq = useRef<string[]>([]);
  if (filter.labels.length === 0) freq.current = items.flatMap((e) => e.labels);
  const labelOptions = useMemo(() => {
    const enabled = cams.flatMap((c) => (c.config.enabled && c.config.detect?.enabled ? c.config.detect.labels : []));
    // 勾著的類別一定要在清單裡，才能取消
    return eventLabelOptions(catalog, [...enabled, ...filter.labels], freq.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, catalog, cams, search.label]);

  const camEntries: SelectEntry<string>[] = [{ value: "", label: "所有攝影機" }, "separator", ...cams.map((c) => ({ value: c.id, label: c.config.name }))];
  const ALL = { value: "", label: "所有類別" };
  // 照選單的順序念，不照網址上排序過的鍵
  const labelNames = labelOptions.filter((o) => filter.labels.includes(o.key)).map((o) => o.zh);
  const labelSummary = labelNames.length === 0 ? ALL.label : labelNames.length <= 2 ? labelNames.join("、") : `${labelNames[0]}等 ${labelNames.length} 類`;
  const opt = (l: { key: string; zh: string }) => ({ value: l.key, label: l.zh });
  const labelEntries: SelectEntry<string>[] = [ALL, "separator", ...labelOptions.map(opt)];
  /** 還沒有任何事件帶類別（沒用物件辨識、相機也沒回報）就不佔位；篩選中一定要看得到 */
  const showLabelPick = filter.labels.length > 0 || items.some((e) => e.labels.length > 0);

  // 自動載下一頁：觀察底部的哨兵；畫面很高、第一頁就到不了底部時觀察器不會再觸發，所以每次載完也檢查一次
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  const canMore = list.isSuccess && hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canMore) return;
    const check = () => el.getBoundingClientRect().top < innerHeight + PRELOAD_PX;
    if (check()) {
      void fetchNextPage();
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((x) => x.isIntersecting) && void fetchNextPage(), { rootMargin: `0px 0px ${PRELOAD_PX}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [canMore, fetchNextPage, list.data]);

  async function remove(e: EventDto, el: HTMLElement | null) {
    if (e.endMs === null) return toast("事件還在進行中，結束後才能刪除", "error");
    const ok = await confirmDialog("刪除這筆事件？", `${nameOf(e.cameraId)}，${dayTitle(dayKey(e.startMs), Date.now())} ${formatClock(e.startMs)}。事件與縮圖會永久刪除，錄影之後照一般的保留天數清除。`, { confirmLabel: "刪除", danger: true });
    if (!ok) return;
    try {
      await api.deleteEvent(e.id);
    } catch (err) {
      return toast(errMsg(err), "error");
    }
    const drop = () =>
      qc.setQueryData<InfiniteData<Page, number | null>>(key, (d) => d && { ...d, pages: d.pages.map((p) => ({ ...p, events: p.events.filter((x) => x.id !== e.id) })) });
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) drop();
    else el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.96)" }], { duration: 160, easing: "ease-out" }).finished.then(drop, drop);
    toast("已刪除事件");
  }

  const who = filter.camera ? `「${nameOf(filter.camera)}」` : "";
  const when = filter.date ? dayTitle(filter.date, Date.now()) : "";
  const what = filter.labels.length ? labelSummary : "";
  const narrowed = [who, when, what].filter(Boolean).length;

  let body: React.ReactNode;
  if (list.isPending) {
    body = (
      <div className="ev-day" aria-busy="true">
        <span className="ev-skel-title" />
        <ul className="ev-grid" role="presentation">
          {Array.from({ length: 8 }, (_, i) => (
            <li className="ev-card ev-skel" key={i}>
              <span className="ev-card-thumb" />
              <span className="ev-skel-line" />
              <span className="ev-skel-line short" />
            </li>
          ))}
        </ul>
        <span className="sr-only" role="status">
          載入中…
        </span>
      </div>
    );
  } else if (list.isError && !list.data) {
    body = <ErrorBox error={list.error} onRetry={() => void list.refetch()} />;
  } else if (items.length === 0) {
    if (narrowed === 0) body = <EmptyState icon="activity" title="還沒有事件" body="攝影機偵測到動作時，事件會出現在這裡。" />;
    else {
      const title = what ? `${who}${when}沒有看到${what}的事件` : when ? `${who}${when}沒有事件` : `${who}還沒有事件`;
      body = (
        <EmptyState
          icon="activity"
          title={title}
          body={what ? "換個類別或日期看看，或清除篩選。" : when ? "換一天看看，或清除篩選。" : "這台偵測到動作時，事件會出現在這裡。"}
          action={<Button onClick={resetFilter}>{narrowed > 1 ? "清除篩選" : what ? "看所有類別" : who ? "看所有攝影機" : "看所有日期"}</Button>}
        />
      );
    }
  } else {
    body = groupByDay(items).map((g) => (
      <section className="ev-day" key={g.key} aria-label={dayTitle(g.key, now)}>
        {filter.date ? null : <h2 className="ev-day-title">{dayTitle(g.key, now)}</h2>}
        <ul className="ev-grid">
          {g.events.map((e) => (
            <EventCard key={e.id} e={e} now={now} name={nameOf(e.cameraId)} admin={isAdmin} onRemove={remove} />
          ))}
        </ul>
      </section>
    ));
  }

  const showFoot = list.isSuccess && items.length > 0;
  return (
    <div className="ev-page">
      <Header>
        <div className="ev-filters">
          <Select label="攝影機" icon="camera" entries={camEntries} value={filter.camera ?? ""} onChange={(v) => setFilter({ ...filter, camera: v || null })} />
          {showLabelPick ? (
            <MultiSelect
              label="類別"
              icon="tag"
              entries={labelEntries}
              summary={labelSummary}
              // 沒勾任何類別時「所有類別」打勾；勾了「所有類別」就清掉其他的
              value={filter.labels.length ? filter.labels : [""]}
              onChange={(v) => setFilter({ ...filter, labels: v.includes("") && filter.labels.length ? [] : v.filter((l) => l !== "") })}
            />
          ) : null}
          <DatePicker label="日期" value={filter.date} clearLabel="所有日期" max={dayOf(Date.now())} onChange={(date) => setFilter({ ...filter, date })} />
        </div>
      </Header>
      <div className="ev-body">{body}</div>
      <div className="ev-sentinel" ref={sentinel} aria-hidden="true" />
      <div className="ev-foot-wrap" role="status" aria-live="polite">
        <div className="ev-foot">
          {!showFoot ? null : isFetchingNextPage ? (
            <>
              <span className="spin" />
              <span>載入更早的事件…</span>
            </>
          ) : isFetchNextPageError ? (
            <>
              <span>更早的事件沒有載入成功</span>
              <Button small icon="refresh" iconSize={15} onClick={() => void fetchNextPage()}>
                再試一次
              </Button>
            </>
          ) : !hasNextPage ? (
            <span>{filter.date ? "這天沒有更早的事件了" : "沒有更早的事件了"}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EventCard({ e, now, name, admin, onRemove }: { e: EventDto; now: number; name: string; admin: boolean; onRemove: (e: EventDto, el: HTMLElement | null) => void }) {
  const li = useRef<HTMLLIElement>(null);
  const live = e.endMs === null;
  const len = (e.endMs ?? now) - e.startMs;
  const labels = e.labels.length ? labelText(e.labels) : null;
  return (
    <li className="ev-card" ref={li} data-live={live ? "" : undefined}>
      <Link
        className="ev-card-link"
        to="/recordings"
        search={playbackSearch(e)}
        aria-label={`${name}，${dayTitle(dayKey(e.startMs), now)} ${formatClock(e.startMs)}${labels ? `，${labels}` : ""}，${live ? `${EVENT_ACTIVE.badge}，已持續 ${spoken(len)}` : `長度 ${spoken(len)}`}，播放錄影`}
      >
        <span className="ev-card-thumb">
          {e.hasThumb ? (
            <img src={api.eventThumbUrl(e.id)} alt="" loading="lazy" decoding="async" width="320" height="180" />
          ) : (
            <span className="cam-ph">
              <Icon name="activity" size={22} />
            </span>
          )}
          <span className="ev-chip num">{live ? `${EVENT_ACTIVE.badge} ${clip(len)}` : clip(len)}</span>
        </span>
        <span className="ev-card-text">
          <b className="num">{formatClock(e.startMs)}</b>
          <span className="ev-card-sub">{name}</span>
          <span className="ev-tags" hidden={e.labels.length === 0}>
            {[...new Set(e.labels)].map((l) => (
              <span className="ev-tag" key={l}>
                {labelName(l)}
              </span>
            ))}
          </span>
        </span>
      </Link>
      {admin ? (
        <span className="menu-wrap">
          <MenuButton label="這筆事件的更多動作" items={[{ label: "刪除事件", icon: "trash", danger: true, onSelect: () => onRemove(e, li.current) }]} />
        </span>
      ) : null}
    </li>
  );
}
