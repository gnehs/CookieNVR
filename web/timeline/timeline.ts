import type { EventDto, SegmentDto } from "../../src/api-types.ts";
import { formatClock, formatDuration, h } from "../dom.ts";
import { browserOffset, clusterEvents, labelText, recordedSpans, tickLabel, ticks, tickSteps, type Cluster, type Span } from "./model.ts";

export type Orientation = "h" | "v";

export interface TimelineOptions {
  /** A click or key press asked to play from wall time w; dir says which way a gap should be skipped. */
  onSeek(w: number, dir: 1 | -1): void;
  onEvent(e: EventDto): void;
  /** follow turned off by panning, or back on */
  onFollow(follow: boolean): void;
  /** the visible span changed by wheel or pinch */
  onSpan(spanMs: number): void;
  thumbUrl(e: EventDto): string;
}

const MIN_SPAN = 60_000;
const COLORS = ["--tl-track", "--tl-recorded", "--tl-recorded-live", "--tl-gap", "--tl-gap-hatch", "--tl-event", "--tl-event-fg", "--tl-playhead", "--tl-tick", "--muted", "--text", "--text-2", "--surface", "--border", "--accent", "--fill"] as const;
/** derived shades, resolved through the same probe */
const MIXES = { "event-hover": "color-mix(in srgb, var(--tl-event) 72%, var(--text))" } as const;
type ColorName = (typeof COLORS)[number] | keyof typeof MIXES;

/** Layout of the horizontal strip, CSS px */
const H = { labelY: 14, tickTop: 20, trackTop: 30, trackH: 44, height: 92, eventInset: 5, minEventPx: 4, hitSlop: 3 };
/** Layout of the vertical strip, CSS px */
const V = { labelRight: 40, tickLeft: 48, trackLeft: 56, trackW: 18, cardLeft: 86, cardH: 60, cardGap: 6, minEventPx: 6 };

interface Hit {
  a0: number;
  a1: number;
  /** cross-axis extent, for vertical cards */
  b0: number;
  b1: number;
  cluster: Cluster;
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * The playback timeline, drawn on one canvas so panning and the moving
 * playhead never touch the DOM. Horizontal on wide screens, vertical (with an
 * event card per cluster) on phones.
 */
export class Timeline {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private probe: HTMLSpanElement;
  private colors = {} as Record<ColorName, string>;
  private hatch: CanvasPattern | null = null;
  private orient: Orientation = "h";
  private w = 0;
  private hgt = 0;
  private dpr = 1;

  private bounds = { start: 0, end: 86_400_000 };
  private viewStart = 0;
  private span = 86_400_000;
  private segs: SegmentDto[] = [];
  private spans: Span[] = [];
  private events: EventDto[] = [];
  private now = Date.now();
  private playhead: number | null = null;
  private hover: number | null = null;
  private hoverB = 0;
  private hoverHit: Hit | null = null;
  private hits: Hit[] = [];
  private thumbs = new Map<number, HTMLImageElement>();
  follow = true;

  private dirty = true;
  private raf = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { a0: number; view0: number; moved: boolean; samples: { a: number; t: number }[] } | null = null;
  private pinch: { d0: number; span0: number; anchorMs: number; anchorA: number } | null = null;
  private inertia = 0;
  private ro: ResizeObserver;
  private themeObs: MutationObserver;
  private onScheme = () => this.readColors();

  constructor(private readonly opts: TimelineOptions) {
    this.canvas = h("canvas", { class: "tl-canvas", "aria-hidden": "true" });
    this.ctx = this.canvas.getContext("2d")!;
    this.tip = h("div", { class: "tl-tip", "aria-hidden": "true", hidden: true });
    this.probe = h("span", { class: "tl-probe", "aria-hidden": "true" });
    this.el = h(
      "div",
      {
        class: "tl",
        tabindex: "0",
        role: "slider",
        "aria-label": "時間軸",
        "aria-roledescription": "時間軸",
        "aria-keyshortcuts": "ArrowLeft ArrowRight PageUp PageDown Home End",
      },
      this.canvas,
      this.tip,
      this.probe,
    );
    this.readColors();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.themeObs = new MutationObserver(() => this.readColors());
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) this.themeObs.observe(meta, { attributes: true });
    this.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-accent"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", this.onScheme);

    const c = this.el;
    c.addEventListener("pointerdown", (e) => this.down(e));
    c.addEventListener("pointermove", (e) => this.move(e));
    c.addEventListener("pointerup", (e) => this.up(e));
    c.addEventListener("pointercancel", (e) => this.cancel(e));
    c.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && !this.drag) this.setHover(null, null);
    });
    c.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    c.addEventListener("keydown", (e) => this.key(e));
    this.loop();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.inertia);
    this.ro.disconnect();
    this.themeObs.disconnect();
    matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", this.onScheme);
  }

  setOrientation(o: Orientation) {
    if (o === this.orient) return;
    this.orient = o;
    this.el.dataset.orient = o;
    this.el.setAttribute("aria-orientation", o === "h" ? "horizontal" : "vertical");
    this.setHover(null, null);
    this.resize();
  }

  /** The day (or any window) the timeline can pan over. */
  setBounds(start: number, end: number) {
    const keepSpan = Math.min(this.span, end - start);
    this.bounds = { start, end };
    this.el.setAttribute("aria-valuemin", String(start));
    this.el.setAttribute("aria-valuemax", String(end));
    this.span = keepSpan;
    this.viewStart = this.clampStart(this.playhead !== null ? this.playhead - keepSpan / 2 : start);
    this.dirty = true;
  }

  setData(segs: SegmentDto[], events: EventDto[], now: number) {
    this.segs = segs;
    this.events = events;
    this.now = now;
    this.spans = recordedSpans(segs, now);
    this.dirty = true;
  }

  get spanMs(): number {
    return this.span;
  }

  /** Zooms to a preset span, keeping the playhead (or the view centre) in place. */
  setSpan(ms: number) {
    const anchor = this.playhead !== null && this.inView(this.playhead) ? this.playhead : this.viewStart + this.span / 2;
    const frac = (anchor - this.viewStart) / this.span;
    this.span = this.clampSpan(ms);
    this.viewStart = this.clampStart(anchor - frac * this.span);
    this.dirty = true;
  }

  setPlayhead(w: number | null) {
    if (w === this.playhead) return;
    this.playhead = w;
    if (w !== null) {
      this.el.setAttribute("aria-valuenow", String(Math.round(w)));
      this.el.setAttribute("aria-valuetext", formatClock(w));
      if (this.follow && !this.drag && !this.pinch) this.keepVisible(w);
    }
    this.dirty = true;
  }

  /** Brings the playhead back into view and resumes following it. */
  recenter() {
    this.setFollow(true);
    if (this.playhead !== null) this.viewStart = this.clampStart(this.playhead - this.span / 2);
    this.dirty = true;
  }

  private setFollow(f: boolean) {
    if (f === this.follow) return;
    this.follow = f;
    this.opts.onFollow(f);
  }

  private inView(w: number) {
    return w >= this.viewStart && w <= this.viewStart + this.span;
  }

  private keepVisible(w: number) {
    const frac = (w - this.viewStart) / this.span;
    if (frac >= 0.08 && frac <= 0.8) return;
    // a jump lands mid-view; normal playback scrolls so the playhead stays at 80%
    const target = frac > 0.8 && frac < 1.05 ? w - 0.8 * this.span : w - 0.5 * this.span;
    this.viewStart = this.clampStart(target);
  }

  private clampSpan(ms: number) {
    return Math.max(MIN_SPAN, Math.min(ms, this.bounds.end - this.bounds.start));
  }

  private clampStart(s: number) {
    return Math.max(this.bounds.start, Math.min(s, this.bounds.end - this.span));
  }


  private get axisLen() {
    return this.orient === "h" ? this.w : this.hgt;
  }

  private get msPerPx() {
    return this.span / Math.max(1, this.axisLen);
  }

  private pos(ms: number) {
    return (ms - this.viewStart) / this.msPerPx;
  }

  private at(a: number) {
    return this.viewStart + a * this.msPerPx;
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    // input can arrive before the first ResizeObserver callback
    if (this.w !== Math.round(r.width) || this.hgt !== Math.round(r.height)) this.resize();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return this.orient === "h" ? { a: x, b: y } : { a: y, b: x };
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.round(r.width);
    this.hgt = Math.round(r.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    // computed styles only resolve once the element is in the document
    if (!this.colors["--tl-track"]) this.readColors();
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.hgt * this.dpr);
    this.makeHatch();
    this.dirty = true;
  }

  private readColors() {
    const p = this.probe;
    for (const name of COLORS) {
      p.style.color = `var(${name})`;
      this.colors[name] = getComputedStyle(p).color;
    }
    for (const [name, css] of Object.entries(MIXES) as [keyof typeof MIXES, string][]) {
      p.style.color = css;
      this.colors[name] = getComputedStyle(p).color;
    }
    if (!p.isConnected) this.colors["--tl-track"] = "";
    this.makeHatch();
    this.dirty = true;
  }

  private makeHatch() {
    const size = Math.round(8 * this.dpr);
    const off = document.createElement("canvas");
    off.width = off.height = size;
    const g = off.getContext("2d")!;
    g.fillStyle = this.colors["--tl-gap"];
    g.fillRect(0, 0, size, size);
    g.strokeStyle = this.colors["--tl-gap-hatch"];
    g.lineWidth = 1.5 * this.dpr;
    g.beginPath();
    g.moveTo(-1, size + 1);
    g.lineTo(size + 1, -1);
    g.moveTo(-1, 1);
    g.lineTo(1, -1);
    g.moveTo(size - 1, size + 1);
    g.lineTo(size + 1, size - 1);
    g.stroke();
    this.hatch = this.ctx.createPattern(off, "repeat");
  }


  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    cancelAnimationFrame(this.inertia);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {}
    if (this.pointers.size === 2) {
      this.drag = null;
      this.startPinch();
      return;
    }
    if (this.pointers.size > 2) return;
    const { a } = this.local(e);
    this.drag = { a0: a, view0: this.viewStart, moved: false, samples: [{ a, t: e.timeStamp }] };
  }

  private startPinch() {
    const [p, q] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    const r = this.canvas.getBoundingClientRect();
    const mid = this.orient === "h" ? (p.x + q.x) / 2 - r.left : (p.y + q.y) / 2 - r.top;
    this.pinch = { d0: Math.max(10, Math.hypot(p.x - q.x, p.y - q.y)), span0: this.span, anchorMs: this.at(mid), anchorA: mid };
    this.setHover(null, null);
  }

  private move(e: PointerEvent) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const [p, q] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.max(10, Math.hypot(p.x - q.x, p.y - q.y));
      this.zoomAround(this.pinch.anchorMs, this.pinch.anchorA, this.pinch.span0 * (this.pinch.d0 / d));
      return;
    }
    const { a, b } = this.local(e);
    if (this.drag) {
      const da = a - this.drag.a0;
      if (!this.drag.moved && Math.abs(da) > 4) {
        this.drag.moved = true;
        this.el.classList.add("dragging");
        this.setHover(null, null);
        this.setFollow(false);
      }
      if (this.drag.moved) {
        this.viewStart = this.clampStart(this.drag.view0 - da * this.msPerPx);
        this.drag.samples.push({ a, t: e.timeStamp });
        if (this.drag.samples.length > 5) this.drag.samples.shift();
        this.dirty = true;
      }
      return;
    }
    if (e.pointerType === "mouse") {
      this.hoverB = b;
      this.setHover(a, this.hitTest(a, b));
    }
  }

  private up(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const drag = this.drag;
    this.drag = null;
    this.el.classList.remove("dragging");
    if (!drag) return;
    const { a, b } = this.local(e);
    if (drag.moved) {
      this.fling(drag.samples);
      return;
    }
    const hit = this.hitTest(a, b);
    if (hit) {
      if (hit.cluster.count === 1) {
        this.setFollow(true);
        this.opts.onEvent(this.events[hit.cluster.first]!);
      } else {
        this.zoomToCluster(hit.cluster);
      }
      return;
    }
    this.setFollow(true);
    this.opts.onSeek(this.at(a), 1);
  }

  private cancel(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    this.pinch = null;
    this.drag = null;
    this.el.classList.remove("dragging");
  }

  /** Momentum after a flick; skipped under reduced motion. */
  private fling(samples: { a: number; t: number }[]) {
    if (reducedMotion.matches || samples.length < 2) return;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const dt = last.t - first.t;
    if (dt <= 0 || performance.now() - last.t > 80) return;
    let v = (last.a - first.a) / dt;
    if (Math.abs(v) < 0.3) return;
    let prev = performance.now();
    const step = (t: number) => {
      const dt2 = t - prev;
      prev = t;
      this.viewStart = this.clampStart(this.viewStart - v * dt2 * this.msPerPx);
      v *= Math.pow(0.94, dt2 / 16);
      this.dirty = true;
      if (Math.abs(v) > 0.02) this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    cancelAnimationFrame(this.inertia);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.axisLen : 1;
    const { a } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoomAround(this.at(a), a, this.span * Math.exp(e.deltaY * unit * 0.01));
      return;
    }
    const delta = this.orient === "h" && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    this.viewStart = this.clampStart(this.viewStart + delta * unit * this.msPerPx);
    this.setFollow(false);
    this.setHover(null, null);
    this.dirty = true;
  }

  private zoomAround(anchorMs: number, anchorA: number, span: number) {
    this.span = this.clampSpan(span);
    this.viewStart = this.clampStart(anchorMs - anchorA * this.msPerPx);
    this.opts.onSpan(this.span);
    this.dirty = true;
  }

  private zoomToCluster(c: Cluster) {
    const len = Math.max(c.end - c.start, MIN_SPAN / 2);
    // always zoom in at least 3x, so a cluster that still holds after zooming splits on the next tap
    this.span = this.clampSpan(Math.min(len * 2.2, this.span / 3));
    this.viewStart = this.clampStart(c.start - (this.span - len) / 2);
    this.setFollow(false);
    this.opts.onSpan(this.span);
    this.setHover(null, null);
    this.dirty = true;
  }

  private key(e: KeyboardEvent) {
    const base = this.playhead ?? this.viewStart + this.span / 2;
    const fwd = this.orient === "h" ? ["ArrowRight", "ArrowUp"] : ["ArrowDown", "ArrowRight"];
    const back = this.orient === "h" ? ["ArrowLeft", "ArrowDown"] : ["ArrowUp", "ArrowLeft"];
    const stepMs = e.shiftKey ? 60_000 : 10_000;
    let seek: { w: number; dir: 1 | -1 } | null = null;
    if (fwd.includes(e.key)) seek = { w: base + stepMs, dir: 1 };
    else if (back.includes(e.key)) seek = { w: base - stepMs, dir: -1 };
    else if (e.key === "PageDown") seek = { w: base + 600_000, dir: 1 };
    else if (e.key === "PageUp") seek = { w: base - 600_000, dir: -1 };
    else if (e.key === "Home" && this.segs[0]) seek = { w: this.segs[0].startMs, dir: 1 };
    else if (e.key === "End" && this.segs.length) seek = { w: this.now - 10_000, dir: -1 };
    else if (e.key === "+" || e.key === "=") this.zoomAround(base, this.pos(base), this.span / 2);
    else if (e.key === "-" || e.key === "_") this.zoomAround(base, this.pos(base), this.span * 2);
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (seek) {
      this.setFollow(true);
      this.opts.onSeek(seek.w, seek.dir);
    }
  }

  private hitTest(a: number, b: number): Hit | null {
    for (const hit of this.hits) {
      if (a >= hit.a0 - 2 && a <= hit.a1 + 2 && b >= hit.b0 && b <= hit.b1) return hit;
    }
    return null;
  }

  /** After a zoom or pan the clusters under a still pointer change; re-resolve against the new layout. */
  private refreshHover() {
    if (this.hover === null) return;
    const hit = this.hitTest(this.hover, this.hoverB);
    const same = hit?.cluster.first === this.hoverHit?.cluster.first && hit?.cluster.count === this.hoverHit?.cluster.count;
    if (same) {
      if (hit) this.hoverHit = hit;
      return;
    }
    this.hoverHit = hit;
    this.el.style.cursor = hit ? "pointer" : "";
    this.renderTip(hit);
    this.dirty = true;
  }

  private setHover(a: number | null, hit: Hit | null) {
    if (a === this.hover && hit === this.hoverHit) return;
    this.hover = a;
    this.el.style.cursor = hit ? "pointer" : "";
    if (hit !== this.hoverHit) {
      this.hoverHit = hit;
      this.renderTip(hit);
    } else if (hit) this.placeTip(hit);
    this.dirty = true;
  }


  private renderTip(hit: Hit | null) {
    const tip = this.tip;
    if (!hit || this.orient === "v") {
      tip.hidden = true;
      return;
    }
    const c = hit.cluster;
    const evs = this.events.slice(c.first, c.first + c.count);
    const first = evs[0]!;
    if (c.count === 1) {
      const end = first.endMs;
      tip.replaceChildren(
        ...(first.hasThumb ? [h("img", { src: this.opts.thumbUrl(first), alt: "", width: "112", height: "63" })] : []),
        h("div", { class: "tl-tip-body" },
          h("b", null, labelText(first.labels)),
          h("span", { class: "num" }, `${formatClock(first.startMs)} – ${end === null ? "進行中" : formatClock(end)}`),
          h("span", null, end === null ? `已持續 ${formatDuration(this.now - first.startMs)}` : `長度 ${formatDuration(end - first.startMs)}`),
        ),
      );
    } else {
      const labels = [...new Set(evs.flatMap((e) => e.labels))];
      const lastEnd = Math.max(...evs.map((e) => e.endMs ?? this.now));
      tip.replaceChildren(
        h("div", { class: "tl-tip-body" },
          h("b", null, `${c.count} 個事件`),
          h("span", { class: "num" }, `${formatClock(first.startMs)} – ${formatClock(lastEnd)}`),
          h("span", null, labelText(labels)),
          h("span", { class: "hint" }, "點一下放大這一段"),
        ),
      );
    }
    tip.hidden = false;
    this.placeTip(hit);
  }

  private placeTip(hit: Hit) {
    const tipW = this.tip.offsetWidth;
    const mid = (hit.a0 + hit.a1) / 2;
    const x = Math.max(4, Math.min(this.w - tipW - 4, mid - tipW / 2));
    this.tip.style.transform = `translate(${Math.round(x)}px, 0)`;
  }


  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dirty || this.w === 0 || this.hgt === 0) return;
    this.dirty = false;
    this.draw();
  };

  private draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.hgt);
    if (this.orient === "h") this.drawH();
    else this.drawV();
  }

  /** Fills a rect along the axis [a0, a1] and across [b0, b1], in either orientation. */
  private rect(a0: number, a1: number, b0: number, b1: number) {
    if (this.orient === "h") this.ctx.fillRect(a0, b0, a1 - a0, b1 - b0);
    else this.ctx.fillRect(b0, a0, b1 - b0, a1 - a0);
  }

  private roundRect(a0: number, a1: number, b0: number, b1: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (this.orient === "h") ctx.roundRect(a0, b0, a1 - a0, b1 - b0, r);
    else ctx.roundRect(b0, a0, b1 - b0, a1 - a0, r);
    ctx.fill();
  }

  private drawTrack(b0: number, b1: number) {
    const { ctx, colors } = this;
    const len = this.axisLen;
    // the whole day reads as a gap first, then recorded spans paint over it
    ctx.fillStyle = this.hatch ?? colors["--tl-gap"];
    const dayA0 = Math.max(0, this.pos(this.bounds.start));
    const dayA1 = Math.min(len, this.pos(Math.min(this.bounds.end, this.now)));
    if (dayA1 > dayA0) this.rect(dayA0, dayA1, b0, b1);
    ctx.fillStyle = colors["--tl-track"];
    const futureA0 = Math.max(0, this.pos(this.now));
    if (futureA0 < len) this.rect(futureA0, len, b0, b1);

    const viewEnd = this.viewStart + this.span;
    for (const s of this.spans) {
      if (s.end < this.viewStart || s.start > viewEnd) continue;
      const a0 = Math.max(-1, this.pos(s.start));
      const a1 = Math.min(len + 1, Math.max(a0 + 1, this.pos(s.end)));
      ctx.fillStyle = colors["--tl-recorded"];
      this.rect(a0, a1, b0, b1);
      if (s.liveFrom !== null) {
        ctx.fillStyle = colors["--tl-recorded-live"];
        this.rect(Math.max(a0, this.pos(s.liveFrom)), a1, b0, b1);
      }
    }
  }

  private drawTicks(crossTop: number, labelAt: number) {
    const { ctx, colors } = this;
    const labelPx = this.orient === "h" ? 64 : 40;
    const { major, minor } = tickSteps(this.msPerPx, labelPx);
    const viewEnd = this.viewStart + this.span;
    ctx.fillStyle = colors["--tl-tick"];
    for (const t of ticks(this.viewStart, viewEnd, minor, browserOffset)) {
      const a = Math.round(this.pos(t));
      this.rect(a, a + 1, crossTop + 5, crossTop + 9);
    }
    ctx.font = "500 11px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    for (const t of ticks(this.viewStart - major, viewEnd + major, major, browserOffset)) {
      const a = Math.round(this.pos(t));
      ctx.fillStyle = colors["--tl-tick"];
      this.rect(a, a + 1, crossTop, crossTop + 9);
      const text = tickLabel(t, major);
      ctx.fillStyle = text.includes("/") ? colors["--text"] : colors["--muted"];
      if (this.orient === "h") {
        const half = ctx.measureText(text).width / 2 + 2;
        if (a < 0 || a > this.w) continue;
        ctx.textAlign = "center";
        ctx.fillText(text, Math.max(half, Math.min(this.w - half, a)), labelAt);
      } else {
        if (a < 0 || a > this.hgt) continue;
        ctx.textAlign = "right";
        ctx.fillText(text, labelAt, Math.max(7, Math.min(this.hgt - 7, a)));
      }
    }
  }

  private drawPlayhead(b0: number, b1: number) {
    if (this.playhead === null) return;
    const a = this.pos(this.playhead);
    if (a < -2 || a > this.axisLen + 2) return;
    const { ctx, colors } = this;
    ctx.fillStyle = colors["--tl-playhead"];
    this.rect(Math.round(a) - 1, Math.round(a) + 1, b0, b1);
    ctx.beginPath();
    if (this.orient === "h") {
      ctx.moveTo(a - 6, b0);
      ctx.lineTo(a + 6, b0);
      ctx.lineTo(a, b0 + 7);
    } else {
      ctx.moveTo(b0, a - 6);
      ctx.lineTo(b0, a + 6);
      ctx.lineTo(b0 + 7, a);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawHover(b0: number, b1: number) {
    if (this.hover === null || this.drag) return;
    const { ctx, colors } = this;
    const a = Math.round(this.hover);
    ctx.fillStyle = colors["--muted"];
    this.rect(a, a + 1, b0, b1);
    if (this.hoverHit) return;
    const text = formatClock(this.at(this.hover));
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    const tw = ctx.measureText(text).width + 12;
    const x = Math.max(0, Math.min(this.w - tw, a - tw / 2));
    ctx.fillStyle = colors["--text"];
    ctx.beginPath();
    ctx.roundRect(x, b1 - 18, tw, 18, 6);
    ctx.fill();
    ctx.fillStyle = colors["--surface"];
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + tw / 2, b1 - 9);
  }

  private drawH() {
    const { ctx, colors } = this;
    const top = H.trackTop;
    const bottom = top + H.trackH;
    this.drawTicks(H.tickTop, H.labelY);
    this.drawTrack(top, bottom);

    const view = { start: this.viewStart, end: this.viewStart + this.span, msPerPx: this.msPerPx };
    const clusters = clusterEvents(this.events, this.now, view, H.minEventPx, 2);
    this.hits = [];
    ctx.font = "700 11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const c of clusters) {
      const a0 = this.pos(c.start);
      const a1 = this.pos(c.end);
      const b0 = top + H.eventInset;
      const b1 = bottom - H.eventInset;
      const hovered = this.hoverHit?.cluster.first === c.first && this.hoverHit.cluster.count === c.count;
      ctx.fillStyle = hovered ? colors["event-hover"] : colors["--tl-event"];
      this.roundRect(a0, a1, b0, b1, 4);
      if (c.count > 1 && a1 - a0 >= 18) {
        ctx.fillStyle = colors["--tl-event-fg"];
        ctx.fillText(String(c.count), (a0 + a1) / 2, (b0 + b1) / 2 + 0.5);
      }
      // 4px 寬的事件不好瞄準，命中範圍左右各放寬一點
      this.hits.push({ a0: a0 - H.hitSlop, a1: a1 + H.hitSlop, b0: top - 4, b1: bottom + 4, cluster: c });
    }
    this.refreshHover();
    this.drawPlayhead(4, bottom + 6);
    this.drawHover(top, this.hgt);
  }

  private drawV() {
    const { ctx, colors } = this;
    const left = V.trackLeft;
    const right = left + V.trackW;
    this.drawTicks(V.tickLeft - 4, V.labelRight);
    this.drawTrack(left, right);

    const view = { start: this.viewStart, end: this.viewStart + this.span, msPerPx: this.msPerPx };
    // a cluster per card: events closer than a card's height share one
    const clusters = clusterEvents(this.events, this.now, view, V.cardH, V.cardGap, "anchored");
    this.hits = [];
    const cardRight = this.w - 2;
    const cards: { c: Cluster; top: number }[] = [];
    for (const c of clusters) {
      const a0 = this.pos(c.start);
      const evEnd = Math.max(a0 + V.minEventPx, this.pos(Math.min(c.end, this.lastEnd(c))));
      ctx.fillStyle = colors["--tl-event"];
      this.roundRect(a0, evEnd, left + 3, right - 3, 3);

      const top = a0;
      const bottom = a0 + V.cardH;
      if (bottom < 0 || top > this.hgt) continue;
      ctx.fillStyle = colors["--tl-event"];
      ctx.fillRect(right, top + 10, V.cardLeft - right, 2);
      cards.push({ c, top });
      this.hits.push({ a0: top, a1: bottom, b0: left - 6, b1: cardRight, cluster: c });
    }
    // 播放頭先畫，卡片再蓋上去：線只出現在卡片之間的空隙，不會壓到卡片上的字
    this.drawPlayhead(V.tickLeft - 10, this.w);
    for (const { c, top } of cards) this.drawCard(c, top, V.cardLeft, cardRight);
  }

  private lastEnd(c: Cluster) {
    let end = 0;
    for (let i = c.first; i < c.first + c.count; i++) end = Math.max(end, this.events[i]!.endMs ?? this.now);
    return end;
  }

  private drawCard(c: Cluster, top: number, x0: number, x1: number) {
    const { ctx, colors } = this;
    const hgt = V.cardH - 4;
    ctx.fillStyle = colors["--surface"];
    ctx.beginPath();
    ctx.roundRect(x0, top, x1 - x0, hgt, 10);
    ctx.fill();
    ctx.strokeStyle = colors["--border"];
    ctx.lineWidth = 1;
    ctx.stroke();

    const first = this.events[c.first]!;
    const thumbH = hgt - 8;
    const thumbW = Math.round((thumbH * 16) / 9);
    const tx = x0 + 4;
    const ty = top + 4;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(tx, ty, thumbW, thumbH, 7);
    ctx.clip();
    ctx.fillStyle = colors["--fill"];
    ctx.fillRect(tx, ty, thumbW, thumbH);
    let withThumb: EventDto | undefined;
    for (let i = c.first; i < c.first + c.count && !withThumb; i++) if (this.events[i]!.hasThumb) withThumb = this.events[i];
    const img = withThumb ? this.thumb(withThumb) : null;
    if (img?.complete && img.naturalWidth > 0) ctx.drawImage(img, tx, ty, thumbW, thumbH);
    ctx.restore();
    if (c.count > 1) {
      const label = `+${c.count - 1}`;
      ctx.font = "700 11px system-ui, -apple-system, sans-serif";
      const bw = ctx.measureText(label).width + 10;
      ctx.fillStyle = colors["--tl-event"];
      ctx.beginPath();
      ctx.roundRect(tx + thumbW - bw - 3, ty + thumbH - 19, bw, 16, 8);
      ctx.fill();
      ctx.fillStyle = colors["--tl-event-fg"];
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tx + thumbW - bw / 2 - 3, ty + thumbH - 11);
    }

    const textX = tx + thumbW + 10;
    const maxW = x1 - textX - 8;
    if (maxW < 20) return;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const evs = this.events.slice(c.first, c.first + c.count);
    const title = c.count === 1 ? labelText(first.labels) : `${c.count} 個事件 · ${labelText([...new Set(evs.flatMap((e) => e.labels))])}`;
    const sub =
      c.count === 1
        ? first.endMs === null
          ? `${formatClock(first.startMs)} · 進行中`
          : `${formatClock(first.startMs)} · ${formatDuration(first.endMs - first.startMs)}`
        : `${formatClock(first.startMs)} – ${formatClock(this.lastEnd(c))}`;
    ctx.font = "650 14px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = colors["--text"];
    ctx.fillText(this.fit(title, maxW), textX, top + 22);
    ctx.font = "500 12.5px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = colors["--muted"];
    ctx.fillText(this.fit(sub, maxW), textX, top + 41);
  }

  private fit(text: string, maxW: number) {
    if (this.ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && this.ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  private thumb(e: EventDto): HTMLImageElement {
    let img = this.thumbs.get(e.id);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.onload = () => (this.dirty = true);
      img.src = this.opts.thumbUrl(e);
      this.thumbs.set(e.id, img);
    }
    return img;
  }
}
