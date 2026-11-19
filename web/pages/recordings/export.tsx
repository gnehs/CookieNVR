import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { EventDto, ExportDto, SegmentDto } from "../../../src/api-types.ts";
import type { CameraId } from "../../../src/types.ts";
import { MAX_EXPORT_MS, planExport } from "../../../src/export/plan.ts";
import { api } from "../../api.ts";
import { browserTz, errMsg, formatBytes, formatClock, formatDuration } from "../../format.ts";
import { EVENT_PREROLL_MS } from "../../timeline/model.ts";
import type { Range, Timeline } from "../../timeline/timeline.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { toast } from "../../ui/toast.tsx";
import { exportsQuery } from "./queries.ts";

const DEFAULT_LENGTH_MS = 60_000;
const POLL_MS = 1_000;

const active = (j: ExportDto) => j.state === "queued" || j.state === "running";
const jobTitle = (j: ExportDto) => `${j.cameraName} ${formatClock(j.startMs)} – ${formatClock(j.endMs)}`;

export interface ExportOptions {
  timeline: RefObject<Timeline | null>;
  cameraId: CameraId;
  segments: SegmentDto[];
  /** Wall time of the playhead, or null before anything plays. */
  wall: () => number | null;
  /** The day the timeline covers. */
  bounds: [number, number];
}

export type ExportUi = ReturnType<typeof useExport>;

/** 匯出：時間軸上的選取範圍、送出、進度與下載。工作清單每秒更新，只在有進行中的工作時 */
export function useExport(o: ExportOptions) {
  const qc = useQueryClient();
  const [selecting, setSelectingState] = useState(false);
  const [sel, setSel] = useState<Range | null>(null);
  const [sending, setSending] = useState(false);
  const jobsQ = useQuery({ ...exportsQuery, refetchInterval: (q) => (q.state.data?.some(active) ? POLL_MS : false) });
  const jobs = jobsQ.data ?? [];

  useEffect(() => {
    const t = o.timeline.current;
    if (!t) return;
    t.setSelectMode(selecting);
    t.setSelection(selecting ? sel : null);
  }, [o.timeline, selecting, sel]);

  // 進行中的工作完成或失敗時通知一次；比對的是上一次看到的狀態
  const seen = useRef(new Map<string, ExportDto["state"]>());
  useEffect(() => {
    if (!jobsQ.data) return;
    for (const j of jobsQ.data) {
      const before = seen.current.get(j.id);
      if (before !== "queued" && before !== "running") continue;
      if (j.state === "done") toast(`匯出完成：${jobTitle(j)}`);
      else if (j.state === "failed") toast(j.error ?? "匯出失敗", "error");
    }
    seen.current = new Map(jobsQ.data.map((j) => [j.id, j.state]));
  }, [jobsQ.data]);

  const addJob = (job: ExportDto) => qc.setQueryData(exportsQuery.queryKey, (list) => [job, ...(list ?? []).filter((j) => j.id !== job.id)]);

  function initialRange(bounds = o.bounds): Range | null {
    const [from, to] = bounds;
    const now = Date.now();
    const at = o.wall() ?? o.segments[0]?.startMs ?? null;
    if (at === null) return null;
    const start = Math.max(from, Math.round(at / 1000) * 1000);
    const end = Math.min(start + DEFAULT_LENGTH_MS, to, now);
    return end - start >= 1000 ? { start, end } : { start: Math.max(from, end - DEFAULT_LENGTH_MS), end };
  }

  function setSelecting(on: boolean) {
    setSelectingState(on);
    if (on && !sel) setSel(initialRange());
  }

  function pin(which: "start" | "end") {
    const w = o.wall();
    if (w === null) return toast("先播放或點一下時間軸，再設定開始與結束", "error");
    const [from, to] = o.bounds;
    const limit = Math.min(to, Date.now());
    const t = Math.round(Math.min(Math.max(w, from), limit) / 1000) * 1000;
    const next: Range =
      which === "start"
        ? { start: t, end: sel && sel.end - t >= 1000 ? sel.end : Math.min(t + DEFAULT_LENGTH_MS, limit) }
        : { start: sel && t - sel.start >= 1000 ? sel.start : Math.max(from, t - DEFAULT_LENGTH_MS), end: t };
    if (next.end - next.start < 1000) return toast("這個位置太靠近邊界，換一個位置試試", "error");
    setSel(next);
  }

  async function start() {
    if (!sel) return;
    setSending(true);
    try {
      addJob(await api.createExport({ cameraId: o.cameraId, startMs: sel.start, endMs: sel.end, tz: browserTz() }));
      setSel(null);
      setSelectingState(false);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSending(false);
    }
  }

  async function remove(id: string) {
    qc.setQueryData(exportsQuery.queryKey, (list) => list?.filter((j) => j.id !== id));
    try {
      await api.deleteExport(id);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  async function exportEvent(e: EventDto) {
    const startMs = e.startMs - EVENT_PREROLL_MS;
    let endMs = (e.endMs ?? Date.now()) + EVENT_PREROLL_MS;
    if (endMs - startMs > MAX_EXPORT_MS) {
      endMs = startMs + MAX_EXPORT_MS;
      toast("事件超過 2 小時，只匯出前 2 小時");
    }
    try {
      addJob(await api.createExport({ cameraId: e.cameraId, startMs, endMs, tz: browserTz() }));
      toast("已加入匯出，完成後可以在時間軸下方下載");
    } catch (err) {
      toast(errMsg(err), "error");
    }
  }

  return {
    selecting,
    sel,
    sending,
    jobs,
    segments: o.segments,
    setSelecting,
    pin,
    start,
    remove,
    exportEvent,
    /** A drag on the timeline moved the selection. */
    select: setSel,
    /** A different day was loaded; yesterday's range means nothing there. */
    reset(bounds: [number, number]) {
      setSel(selecting ? initialRange(bounds) : null);
    },
  };
}

export function ExportButton({ ui }: { ui: ExportUi }) {
  return (
    <Button small icon="download" className={ui.selecting ? "active" : undefined} aria-pressed={ui.selecting} onClick={() => ui.setSelecting(!ui.selecting)}>
      匯出
    </Button>
  );
}

/** The selection bar, shown above the timeline while select mode is on. */
export function ExportPick({ ui }: { ui: ExportUi }) {
  const { sel } = ui;
  const plan = sel ? planExport(ui.segments, sel.start, sel.end, Date.now()) : null;
  let meta: { cls: string; text: string };
  if (!sel || !plan) meta = { cls: "ex-meta hint", text: "在時間軸上拖曳選取範圍，或播放到想要的位置再按「設為開始」。" };
  else if (!plan.ok) meta = { cls: "ex-meta bad", text: plan.reason === "too-long" ? `${formatDuration(sel.end - sel.start)}，一次最多匯出 2 小時` : plan.message };
  else {
    const gaps = sel.end - sel.start - plan.durationMs > 1500;
    meta = { cls: "ex-meta", text: `${formatDuration(plan.durationMs)} · 約 ${formatBytes(plan.estimatedBytes)}${gaps ? " · 缺片會略過" : ""}${plan.includesRecording ? " · 到現在為止" : ""}` };
  }
  return (
    <div className="ex-pick" hidden={!ui.selecting}>
      <div className="ex-sum">
        <div className="ex-text">
          <b className="ex-range num">{sel ? `${formatClock(sel.start)} – ${formatClock(sel.end)}` : ""}</b>
          <span className={meta.cls} role="status" aria-live="polite">
            {meta.text}
          </span>
        </div>
        <Button small variant="ghost" iconOnly icon="x" className="ex-close" aria-label="取消選取" onClick={() => ui.setSelecting(false)} />
      </div>
      <div className="ex-acts">
        <Button small onClick={() => ui.pin("start")}>
          設為開始
        </Button>
        <Button small onClick={() => ui.pin("end")}>
          設為結束
        </Button>
        <span className="ex-grow" />
        <Button small variant="primary" icon="download" disabled={!plan?.ok || ui.sending} onClick={() => void ui.start()}>
          匯出
        </Button>
      </div>
    </div>
  );
}

function JobRow({ job: j, onRemove }: { job: ExportDto; onRemove: (id: string) => void }) {
  const dismiss = <Button small variant="ghost" iconOnly icon="x" aria-label="移除這筆匯出" onClick={() => onRemove(j.id)} />;
  let lead, sub, acts;
  if (j.state === "done") {
    lead = <Icon name="check-circle" size={20} />;
    sub = <span className="ex-job-sub">{`${formatDuration(j.durationMs)} · ${formatBytes(j.sizeBytes ?? 0)}`}</span>;
    acts = (
      <>
        <a className="btn small primary" href={api.exportFileUrl(j.id)} download={j.fileName}>
          <Icon name="download" size={16} />
          下載
        </a>
        {dismiss}
      </>
    );
  } else if (j.state === "failed") {
    lead = <Icon name="alert-circle" size={20} />;
    sub = <span className="ex-job-sub bad">{j.error ?? "匯出失敗"}</span>;
    acts = dismiss;
  } else {
    const pct = Math.round(j.progress * 100);
    lead = <span className="spin" />;
    sub = (
      <span className="ex-job-prog">
        <span className="bar ex-bar" role="progressbar" aria-label="匯出進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.state === "running" ? pct : undefined} hidden={j.state === "queued"}>
          <i style={{ width: `${j.state === "running" ? pct : 0}%` }} />
        </span>
        <span className="ex-job-sub">{j.state === "queued" ? (j.ahead ? `排隊中，前面還有 ${j.ahead} 個` : "準備中") : `匯出中 ${pct}%`}</span>
      </span>
    );
    acts = (
      <Button small variant="ghost" aria-label={`取消匯出 ${jobTitle(j)}`} onClick={() => onRemove(j.id)}>
        取消
      </Button>
    );
  }
  return (
    <li className="ex-job" data-state={j.state}>
      <span className="ex-lead">{lead}</span>
      <div className="ex-job-main">
        <b className="ex-job-title num">{jobTitle(j)}</b>
        {sub}
      </div>
      <div className="ex-job-acts">{acts}</div>
    </li>
  );
}

/** Running and finished exports, shown below the timeline. */
export function ExportJobs({ ui }: { ui: ExportUi }) {
  return (
    <section className="ex ex-list" hidden={ui.jobs.length === 0} aria-label="匯出的影片">
      <ul className="ex-jobs" aria-label="匯出工作">
        {ui.jobs.map((j) => (
          <JobRow key={j.id} job={j} onRemove={(id) => void ui.remove(id)} />
        ))}
      </ul>
      <p className="hint ex-keep" hidden={!ui.jobs.some((j) => j.state === "done")}>
        完成的影片會保留 24 小時。
      </p>
    </section>
  );
}
