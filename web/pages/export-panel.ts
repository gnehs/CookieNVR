import type { CameraDto, EventDto, ExportDto, SegmentDto } from "../../src/api-types.ts";
import { MAX_EXPORT_MS, planExport } from "../../src/export/plan.ts";
import { api } from "../api.ts";
import { errMsg, formatBytes, formatClock, formatDuration, h, icon, toast } from "../dom.ts";
import type { PageCtx } from "../router.ts";
import { browserTz } from "../state.ts";
import { EVENT_PREROLL_MS } from "../timeline/model.ts";
import type { Range, Timeline } from "../timeline/timeline.ts";

const DEFAULT_LENGTH_MS = 60_000;

export interface ExportUi {
  /** The selection bar, shown above the timeline while select mode is on. */
  pickEl: HTMLElement;
  /** Running and finished exports, shown below the timeline. */
  jobsEl: HTMLElement;
  /** Toggles select mode; lives in the timeline card's header. */
  button: HTMLButtonElement;
  /** A drag on the timeline moved the selection. */
  select(range: Range): void;
  /** The day's segments changed, so the estimate may have too. */
  refresh(): void;
  /** A different day was loaded; yesterday's range means nothing there. */
  reset(): void;
  exportEvent(e: EventDto): Promise<void>;
}

export interface ExportUiOptions {
  ctx: PageCtx;
  camera: () => CameraDto;
  timeline: Timeline;
  segments: () => SegmentDto[];
  /** Wall time of the playhead, or null before anything plays. */
  wall: () => number | null;
  /** The day the timeline covers. */
  bounds: () => [number, number];
}

const active = (j: ExportDto) => j.state === "queued" || j.state === "running";

interface Row {
  el: HTMLLIElement;
  state: ExportDto["state"];
  update(j: ExportDto): void;
}

export function createExportUi(o: ExportUiOptions): ExportUi {
  let selecting = false;
  let sel: Range | null = null;
  let jobs: ExportDto[] = [];
  const rows = new Map<string, Row>();

  const summary = h("b", { class: "ex-range num" });
  const meta = h("span", { class: "ex-meta", role: "status", "aria-live": "polite" });
  const setStart = h("button", { class: "btn small", type: "button", onclick: () => pin("start") }, "設為開始");
  const setEnd = h("button", { class: "btn small", type: "button", onclick: () => pin("end") }, "設為結束");
  const go = h("button", { class: "btn small primary", type: "button", onclick: () => void start() }, icon("download", 16), "匯出");
  const close = h("button", { class: "btn small ghost icon-only ex-close", type: "button", "aria-label": "取消選取", onclick: () => setSelecting(false) }, icon("x", 16));
  const pick = h(
    "div",
    { class: "ex-pick", hidden: true },
    h("div", { class: "ex-sum" }, h("div", { class: "ex-text" }, summary, meta), close),
    h("div", { class: "ex-acts" }, setStart, setEnd, h("span", { class: "ex-grow" }), go),
  );
  const list = h("ul", { class: "ex-jobs", "aria-label": "匯出工作" });
  const keep = h("p", { class: "hint ex-keep", hidden: true }, "完成的影片會保留 24 小時。");
  const jobsEl = h("section", { class: "ex ex-list", hidden: true, "aria-label": "匯出的影片" }, list, keep);

  const button = h("button", { class: "btn small", type: "button", "aria-pressed": "false", onclick: () => setSelecting(!selecting) }, icon("download", 16), "匯出");

  function setSelecting(on: boolean) {
    selecting = on;
    if (on && !sel) sel = initialRange();
    o.timeline.setSelectMode(on);
    o.timeline.setSelection(on ? sel : null);
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("active", on);
    render();
  }

  function initialRange(): Range | null {
    const [from, to] = o.bounds();
    const now = Date.now();
    const at = o.wall() ?? o.segments()[0]?.startMs ?? null;
    if (at === null) return null;
    const start = Math.max(from, Math.round(at / 1000) * 1000);
    const end = Math.min(start + DEFAULT_LENGTH_MS, to, now);
    return end - start >= 1000 ? { start, end } : { start: Math.max(from, end - DEFAULT_LENGTH_MS), end };
  }

  function pin(which: "start" | "end") {
    const w = o.wall();
    if (w === null) return toast("先播放或點一下時間軸，再設定開始與結束", "error");
    const [from, to] = o.bounds();
    const t = Math.round(Math.min(Math.max(w, from), Math.min(to, Date.now())) / 1000) * 1000;
    const cur = sel;
    let next: Range;
    if (which === "start") {
      next = { start: t, end: cur && cur.end - t >= 1000 ? cur.end : Math.min(t + DEFAULT_LENGTH_MS, Math.min(to, Date.now())) };
    } else {
      next = { start: cur && t - cur.start >= 1000 ? cur.start : Math.max(from, t - DEFAULT_LENGTH_MS), end: t };
    }
    if (next.end - next.start < 1000) return toast("這個位置太靠近邊界，換一個位置試試", "error");
    sel = next;
    o.timeline.setSelection(sel);
    render();
  }

  function renderPick() {
    pick.hidden = !selecting;
    if (!selecting) return;
    if (!sel) {
      summary.textContent = "";
      meta.className = "ex-meta hint";
      meta.textContent = "在時間軸上拖曳選取範圍，或播放到想要的位置再按「設為開始」。";
      go.disabled = true;
      return;
    }
    summary.textContent = `${formatClock(sel.start)} – ${formatClock(sel.end)}`;
    const plan = planExport(o.segments(), sel.start, sel.end, Date.now());
    go.disabled = !plan.ok;
    if (!plan.ok) {
      meta.className = "ex-meta bad";
      meta.textContent = plan.reason === "too-long" ? `${formatDuration(sel.end - sel.start)}，一次最多匯出 2 小時` : plan.message;
      return;
    }
    meta.className = "ex-meta";
    const gaps = sel.end - sel.start - plan.durationMs > 1500;
    meta.textContent = `${formatDuration(plan.durationMs)} · 約 ${formatBytes(plan.estimatedBytes)}${gaps ? " · 缺片會略過" : ""}${plan.includesRecording ? " · 到現在為止" : ""}`;
  }

  function jobTitle(j: ExportDto): string {
    return `${j.cameraName} ${formatClock(j.startMs)} – ${formatClock(j.endMs)}`;
  }

  function makeRow(j: ExportDto): Row {
    const li = h("li", { class: "ex-job", "data-state": j.state });
    const row: Row = { el: li, state: j.state, update: () => {} };
    build(row, j);
    return row;
  }

  function build(row: Row, j: ExportDto) {
    row.state = j.state;
    row.el.dataset.state = j.state;
    const title = h("b", { class: "ex-job-title num" }, jobTitle(j));
    let sub: HTMLElement;
    let lead: HTMLElement;
    let acts: Node[];
    const dismiss = h("button", { class: "btn small ghost icon-only", type: "button", "aria-label": "移除這筆匯出", onclick: () => void remove(j.id) }, icon("x", 16));
    if (j.state === "done") {
      lead = icon("check-circle", 20);
      sub = h("span", { class: "ex-job-sub" }, `${formatDuration(j.durationMs)} · ${formatBytes(j.sizeBytes ?? 0)}`);
      acts = [h("a", { class: "btn small primary", href: api.exportFileUrl(j.id), download: j.fileName }, icon("download", 16), "下載"), dismiss];
      row.update = () => {};
    } else if (j.state === "failed") {
      lead = icon("alert-circle", 20);
      sub = h("span", { class: "ex-job-sub bad" }, j.error ?? "匯出失敗");
      acts = [dismiss];
      row.update = () => {};
    } else {
      const cancel = h("button", { class: "btn small ghost", type: "button", "aria-label": `取消匯出 ${jobTitle(j)}`, onclick: () => void remove(j.id) }, "取消");
      const fill = h("i");
      const bar = h("span", { class: "bar ex-bar", role: "progressbar", "aria-label": "匯出進度", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
      const text = h("span", { class: "ex-job-sub" });
      lead = h("span", { class: "spin" });
      sub = h("span", { class: "ex-job-prog" }, bar, text);
      acts = [cancel];
      row.update = (n) => {
        if (n.state === "queued") {
          bar.hidden = true;
          text.textContent = n.ahead ? `排隊中，前面還有 ${n.ahead} 個` : "準備中";
        } else {
          bar.hidden = false;
          const pct = Math.round(n.progress * 100);
          fill.style.width = `${pct}%`;
          bar.setAttribute("aria-valuenow", String(pct));
          text.textContent = `匯出中 ${pct}%`;
        }
      };
      row.update(j);
    }
    row.el.replaceChildren(h("span", { class: "ex-lead" }, lead), h("div", { class: "ex-job-main" }, title, sub), h("div", { class: "ex-job-acts" }, ...acts));
  }

  function renderJobs() {
    const ids = new Set(jobs.map((j) => j.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    jobs.forEach((j, i) => {
      let row = rows.get(j.id);
      if (!row) {
        row = makeRow(j);
        rows.set(j.id, row);
      } else if (row.state !== j.state) {
        build(row, j);
      } else {
        row.update(j);
      }
      if (list.children[i] !== row.el) list.insertBefore(row.el, list.children[i] ?? null);
    });
    keep.hidden = !jobs.some((j) => j.state === "done");
  }

  function render() {
    renderPick();
    renderJobs();
    jobsEl.hidden = jobs.length === 0;
  }

  async function start() {
    if (!sel) return;
    const cam = o.camera();
    go.disabled = true;
    try {
      const job = await api.createExport({ cameraId: cam.id, startMs: sel.start, endMs: sel.end, tz: browserTz() });
      jobs = [job, ...jobs.filter((j) => j.id !== job.id)];
      sel = null;
      setSelecting(false);
    } catch (e) {
      toast(errMsg(e), "error");
      go.disabled = false;
    }
  }

  async function remove(id: string) {
    jobs = jobs.filter((j) => j.id !== id);
    render();
    try {
      await api.deleteExport(id);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  async function poll() {
    try {
      const next = await api.exports();
      if (!o.ctx.isCurrent()) return;
      for (const j of next) {
        const before = jobs.find((x) => x.id === j.id);
        if (before && active(before) && j.state === "done") toast(`匯出完成：${jobTitle(j)}`);
        if (before && active(before) && j.state === "failed") toast(j.error ?? "匯出失敗", "error");
      }
      jobs = next;
      render();
    } catch {
      // a missed poll is retried a second later
    }
  }
  o.ctx.every(1_000, () => {
    if (jobs.some(active)) void poll();
  });
  void poll();

  return {
    pickEl: pick,
    jobsEl,
    button,
    select(range) {
      sel = range;
      renderPick();
    },
    refresh: () => renderPick(),
    reset() {
      sel = null;
      o.timeline.setSelection(null);
      if (selecting) sel = initialRange();
      o.timeline.setSelection(selecting ? sel : null);
      renderPick();
    },
    async exportEvent(e) {
      const start = e.startMs - EVENT_PREROLL_MS;
      let end = (e.endMs ?? Date.now()) + EVENT_PREROLL_MS;
      if (end - start > MAX_EXPORT_MS) {
        end = start + MAX_EXPORT_MS;
        toast("事件超過 2 小時，只匯出前 2 小時");
      }
      try {
        const job = await api.createExport({ cameraId: e.cameraId, startMs: start, endMs: end, tz: browserTz() });
        jobs = [job, ...jobs.filter((j) => j.id !== job.id)];
        render();
        toast("已加入匯出，完成後可以在時間軸下方下載");
      } catch (err) {
        toast(errMsg(err), "error");
      }
    },
  };
}
