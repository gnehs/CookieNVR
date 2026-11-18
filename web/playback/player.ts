import type { SegmentDto } from "../../src/api-types.ts";
import { mimeType, Mp4Splitter, type InitInfo, type Unit } from "./mp4.ts";
import { bufToWall, offsetFor, trimBefore, wallToBuf, type Placement } from "./timemap.ts";

export type PlayerStatus =
  | { kind: "loading" }
  | { kind: "playing" }
  | { kind: "paused" }
  | { kind: "waiting" }
  | { kind: "ended" }
  | { kind: "error"; message: string };

export interface PlayerSource {
  /** The segment covering wall time w, or the next one after it, with where to start. */
  locate(w: number): Promise<{ seg: SegmentDto; wall: number } | null>;
  /** The segment following seg, asked fresh; null while there is none yet. */
  next(seg: SegmentDto): Promise<SegmentDto | null>;
  url(seg: SegmentDto): string;
}

type MediaSourceCtor = { new (): MediaSource; isTypeSupported(type: string): boolean };

/** MediaSource where it exists, else ManagedMediaSource (iPhone, iOS 17.1+). */
export function mediaSourceCtor(): MediaSourceCtor | null {
  const w = window as unknown as { MediaSource?: MediaSourceCtor; ManagedMediaSource?: MediaSourceCtor };
  return w.MediaSource ?? w.ManagedMediaSource ?? null;
}

class Unsupported extends Error {}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Seconds of video kept ahead of the playhead; faster playback reads further ahead. */
const aheadFor = (rate: number) => Math.min(240, Math.max(20, 20 * rate));
const KEEP_BEHIND = 15;
const LIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;

/**
 * Plays a camera's recording as one continuous video: fMP4 segments are fetched
 * near the playhead and appended to a single SourceBuffer, each one chained onto
 * the end of the previous, with a TimeMap translating between buffer and wall time.
 *
 * Every seek outside the buffer starts a new generation: in-flight fetches are
 * aborted, the buffer is emptied and loading restarts from the target.
 */
export class Player {
  private ms: MediaSource | null = null;
  private opened: Promise<void> | null = null;
  private sb: SourceBuffer | null = null;
  private mime: string | null = null;
  private map: Placement[] = [];
  private gen = 0;
  private ctrl = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  /** where the next generation starts in buffer time, past anything appended before */
  private base = 0;
  /** wall time to show once data for it is appended */
  private pending: number | null = null;
  /** no segment follows the last one loaded (yet) */
  private exhausted = false;
  private wantPlay = false;
  private lastWall: number | null = null;
  private status: PlayerStatus = { kind: "loading" };
  private recoveries = 0;
  private liveSegId: number | null = null;
  private watchdog: ReturnType<typeof setInterval>;
  private readonly Ctor: MediaSourceCtor;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: PlayerSource,
    private readonly onStatus: (s: PlayerStatus) => void,
  ) {
    const Ctor = mediaSourceCtor();
    if (!Ctor) throw new Unsupported("no MediaSource");
    this.Ctor = Ctor;
    // ManagedMediaSource only opens when AirPlay has no alternative source to switch to.
    video.disableRemotePlayback = true;
    const on = (type: string, fn: () => void) => video.addEventListener(type, fn);
    on("playing", () => this.setStatus({ kind: "playing" }));
    on("pause", () => this.pending === null && this.setStatus({ kind: "paused" }));
    on("waiting", () => this.setStatus(this.atEnd() ? { kind: "ended" } : { kind: "waiting" }));
    on("timeupdate", () => {
      const w = this.wall();
      if (w !== null) this.lastWall = w;
      if (this.atEnd() && this.status.kind === "waiting") this.setStatus({ kind: "ended" });
    });
    on("error", () => void this.recover());
    // ManagedMediaSource may evict buffered media on its own; reload when the playhead runs into a hole.
    this.watchdog = setInterval(() => {
      const t = video.currentTime;
      const last = this.map[this.map.length - 1];
      if (this.wantPlay && this.pending === null && last && t < last.bufEnd - 1 && !this.isBuffered(t) && video.readyState < 3) {
        const w = this.wall();
        if (w !== null) void this.reset(w);
      }
    }, 1_000);
  }

  static supported(): boolean {
    return mediaSourceCtor() !== null;
  }

  get state(): PlayerStatus {
    return this.status;
  }

  /** Wall time at the playhead. */
  wall(): number | null {
    if (this.pending !== null) return this.pending;
    return bufToWall(this.map, this.video.currentTime) ?? this.lastWall;
  }

  /** True while the segment under the playhead is still being recorded. */
  get live(): boolean {
    const t = this.video.currentTime;
    const p = this.map.find((x) => x.bufStart <= t && t < x.bufEnd + 0.5);
    return p !== undefined && p.segId === this.liveSegId;
  }

  get playing(): boolean {
    return this.wantPlay;
  }

  setRate(rate: number) {
    this.video.defaultPlaybackRate = rate;
    this.video.playbackRate = rate;
  }

  play() {
    this.wantPlay = true;
    if (this.pending === null) this.video.play().catch(() => this.blocked());
  }

  pause() {
    this.wantPlay = false;
    this.video.pause();
  }

  toggle() {
    if (this.wantPlay && !this.video.paused) this.pause();
    else this.play();
  }

  /** Plays from wall time w: inside the buffer by moving the playhead, otherwise by reloading. */
  seek(w: number, play = this.wantPlay) {
    this.wantPlay = play;
    this.lastWall = w;
    const t = wallToBuf(this.map, w);
    if (t !== null && this.isBuffered(t)) {
      this.pending = null;
      this.video.currentTime = t;
      if (play) this.video.play().catch(() => this.blocked());
      return;
    }
    void this.reset(w);
  }

  destroy() {
    this.gen++;
    this.ctrl.abort();
    clearInterval(this.watchdog);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }

  private setStatus(s: PlayerStatus) {
    if (this.status.kind === "error" && s.kind !== "loading") return;
    this.status = s;
    this.onStatus(s);
  }

  private blocked() {
    // autoplay refused (no user gesture yet): stay paused at the target
    this.wantPlay = false;
    this.setStatus({ kind: "paused" });
  }

  private atEnd(): boolean {
    const last = this.map[this.map.length - 1];
    return this.exhausted && last !== undefined && this.video.currentTime >= last.bufEnd - 0.25;
  }

  private isBuffered(t: number): boolean {
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 0.05 <= t && t <= b.end(i) - 0.1) return true;
    return false;
  }

  private open(): Promise<void> {
    const ms = new this.Ctor();
    this.ms = ms;
    this.sb = null;
    this.mime = null;
    this.base = 0;
    const url = URL.createObjectURL(ms);
    this.opened = new Promise((resolve) => {
      ms.addEventListener(
        "sourceopen",
        () => {
          URL.revokeObjectURL(url);
          resolve();
        },
        { once: true },
      );
    });
    this.video.src = url;
    return this.opened;
  }

  private async recover() {
    if (this.recoveries >= 3) {
      this.setStatus({ kind: "error", message: "影片無法解碼，請重新整理頁面再試一次。" });
      return;
    }
    this.recoveries++;
    const w = this.lastWall;
    this.gen++;
    await this.open();
    if (w !== null) void this.reset(w + 1_000);
  }

  private async reset(w: number) {
    const gen = ++this.gen;
    this.ctrl.abort();
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    this.pending = w;
    this.exhausted = false;
    this.lastWall = w;
    if (this.status.kind !== "error") this.setStatus({ kind: "loading" });

    if (!this.opened || this.ms?.readyState === "closed") await this.open();
    await this.opened;
    if (gen !== this.gen) return;

    const last = this.map[this.map.length - 1];
    if (last) this.base = Math.ceil(last.bufEnd) + 10;
    this.map = [];
    await this.op(gen, (sb) => {
      if (sb.buffered.length > 0) sb.remove(0, Infinity);
    });

    let failures = 0;
    for (;;) {
      if (gen !== this.gen) return;
      try {
        const loc = await this.source.locate(w);
        if (gen !== this.gen) return;
        if (!loc) {
          this.pending = null;
          this.exhausted = true;
          this.setStatus({ kind: "ended" });
          return;
        }
        this.pending = loc.wall;
        await this.pump(gen, loc.seg, signal);
        return;
      } catch (e) {
        if (gen !== this.gen) return;
        if (e instanceof Unsupported) {
          this.setStatus({ kind: "error", message: e.message });
          return;
        }
        if (++failures >= 4) {
          this.setStatus({ kind: "error", message: "無法載入錄影，請檢查連線後再試一次。" });
          return;
        }
        await sleep(1_000 * failures, signal);
        // resume where the playhead is, so a retry does not replay what was already watched
        w = this.wall() ?? w;
        this.map = [];
        await this.op(gen, (sb) => {
          if (sb.buffered.length > 0) sb.remove(0, Infinity);
        });
      }
    }
  }

  /** Loads seg and everything after it, staying aheadFor(rate) seconds in front of the playhead. */
  private async pump(gen: number, first: SegmentDto, signal: AbortSignal) {
    let seg: SegmentDto | null = first;
    while (seg && gen === this.gen) {
      const following = await this.load(gen, seg, signal);
      if (gen !== this.gen) return;
      let next: SegmentDto | null = following ?? (await this.source.next(seg));
      while (!next && gen === this.gen) {
        this.exhausted = true;
        if (this.atEnd() && this.video.readyState < 3) this.setStatus({ kind: "ended" });
        await sleep(IDLE_POLL_MS, signal);
        if (gen !== this.gen) return;
        next = await this.source.next(seg);
      }
      this.exhausted = false;
      seg = next;
    }
  }

  /**
   * Appends one segment. A segment still being recorded is tailed with Range
   * requests until a following segment exists, which is returned.
   */
  private async load(gen: number, seg: SegmentDto, signal: AbortSignal): Promise<SegmentDto | null> {
    const splitter = new Mp4Splitter();
    const placed: { p: Placement | null; offset: number } = { p: null, offset: 0 };
    const handle = (units: Unit[]) => this.appendUnits(gen, seg, units, placed);

    await this.waitForRoom(gen, signal);
    await this.fetchInto(seg, splitter, handle, signal);
    if (seg.endMs !== null) {
      this.settlePending(gen);
      return null;
    }

    this.liveSegId = seg.id;
    for (;;) {
      if (gen !== this.gen) return null;
      this.settlePending(gen);
      await sleep(LIVE_POLL_MS, signal);
      await this.waitForRoom(gen, signal);
      if (gen !== this.gen) return null;
      if ((await this.fetchInto(seg, splitter, handle, signal)) > 0) continue;
      // the file stopped growing: either the recorder moved on to a new file or it is stalled
      const next: SegmentDto | null = await this.source.next(seg);
      if (gen !== this.gen) return null;
      if (next) {
        // the recorder closes a file before opening the next, so this read gets its final bytes
        await this.fetchInto(seg, splitter, handle, signal);
        this.liveSegId = null;
        return next;
      }
    }
  }

  /** Reads the segment from where the splitter left off; returns the number of new bytes. */
  private async fetchInto(seg: SegmentDto, splitter: Mp4Splitter, handle: (u: Unit[]) => Promise<void>, signal: AbortSignal): Promise<number> {
    const from = splitter.received;
    let res: Response;
    try {
      res = await fetch(this.source.url(seg), {
        credentials: "same-origin",
        headers: from > 0 ? { Range: `bytes=${from}-` } : undefined,
        cache: seg.endMs === null ? "no-store" : "default",
        signal,
      });
    } catch (e) {
      if (signal.aborted) return 0;
      throw e;
    }
    if (res.status === 416) return 0;
    if (!res.ok || !res.body) throw new Error(`segment ${seg.id}: HTTP ${res.status}`);
    // a server that ignores Range resends the whole file
    let skip = from > 0 && res.status !== 206 ? from : 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = value;
        if (skip > 0) {
          const drop = Math.min(skip, chunk.length);
          skip -= drop;
          chunk = chunk.subarray(drop);
          if (chunk.length === 0) continue;
        }
        await handle(splitter.push(chunk));
        if (signal.aborted) break;
      }
    } catch (e) {
      if (!signal.aborted) throw e;
    } finally {
      reader.cancel().catch(() => {});
    }
    return splitter.received - from;
  }

  private async appendUnits(gen: number, seg: SegmentDto, units: Unit[], placed: { p: Placement | null; offset: number }) {
    for (const u of units) {
      if (gen !== this.gen) return;
      if (u.kind === "init") {
        await this.ensureBuffer(gen, u.info);
        await this.append(gen, u.bytes);
        continue;
      }
      if (!placed.p) {
        // a leading fragment without the video track cannot be placed; skip it
        if (!u.time) continue;
        const offset = offsetFor(this.map, u.time.start, this.base);
        await this.op(gen, (sb) => {
          sb.timestampOffset = offset;
        });
        placed.offset = offset;
        placed.p = { segId: seg.id, wallStart: seg.startMs, bufStart: offset + u.time.start, bufEnd: offset + u.time.end };
        this.map.push(placed.p);
      }
      await this.append(gen, u.bytes);
      if (gen !== this.gen) return;
      if (u.time) placed.p.bufEnd = Math.max(placed.p.bufEnd, placed.offset + u.time.end);
      this.recoveries = 0;
      this.settlePending(gen, false);
    }
  }

  /** Moves the playhead to the pending wall time once it is appended, or to the newest data when `final`. */
  private settlePending(gen: number, final = true) {
    if (gen !== this.gen || this.pending === null) return;
    const last = this.map[this.map.length - 1];
    if (!last) return;
    const t = wallToBuf(this.map, this.pending);
    let target: number | null = null;
    if (t !== null && t < last.bufEnd - 0.05) target = t;
    else if (final) target = Math.max(last.bufStart, last.bufEnd - 1);
    if (target === null) return;
    this.pending = null;
    this.video.currentTime = target;
    if (this.wantPlay) this.video.play().catch(() => this.blocked());
    else this.setStatus({ kind: "paused" });
  }

  private async ensureBuffer(gen: number, info: InitInfo) {
    const mime = mimeType(info);
    if (!mime) throw new Unsupported("瀏覽器不支援這個編碼，無法播放這段錄影。");
    if (!this.Ctor.isTypeSupported(mime)) {
      const codecs = info.tracks.map((t) => t.codec).join("、");
      throw new Unsupported(`瀏覽器不支援這個編碼（${codecs}），無法播放這段錄影。`);
    }
    if (gen !== this.gen || !this.ms) return;
    if (!this.sb) {
      this.sb = this.ms.addSourceBuffer(mime);
      this.mime = mime;
    } else if (mime !== this.mime) {
      const sb = this.sb;
      if (typeof sb.changeType !== "function") throw new Unsupported("攝影機的編碼改變了，這個瀏覽器無法接續播放。");
      await this.op(gen, () => sb.changeType(mime));
      this.mime = mime;
    }
  }

  private async append(gen: number, bytes: Uint8Array) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.op(gen, (sb) => sb.appendBuffer(bytes as Uint8Array<ArrayBuffer>));
        return;
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "QuotaExceededError") || attempt >= 5 || gen !== this.gen) throw e;
        // the buffer is full: free what has been watched and wait for the playhead to move on
        await this.trim(gen, 2);
        await sleep(1_000, this.ctrl.signal);
      }
    }
  }

  private async waitForRoom(gen: number, signal: AbortSignal) {
    for (;;) {
      if (gen !== this.gen) return;
      await this.trim(gen, KEEP_BEHIND);
      const last = this.map[this.map.length - 1];
      const head = this.pending !== null ? null : this.video.currentTime;
      if (!last || head === null || last.bufEnd - head < aheadFor(this.video.playbackRate)) return;
      await sleep(500, signal);
    }
  }

  private async trim(gen: number, keep: number) {
    const sb = this.sb;
    if (!sb || this.pending !== null) return;
    const cut = this.video.currentTime - keep;
    if (sb.buffered.length === 0 || cut - sb.buffered.start(0) < 10) return;
    await this.op(gen, (b) => b.remove(0, cut));
    this.map = trimBefore(this.map, cut);
  }

  /** Runs one SourceBuffer operation after the previous ones, resolving on its updateend. */
  private op(gen: number, fn: (sb: SourceBuffer) => void): Promise<void> {
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const sb = this.sb;
        if (gen !== this.gen || !sb || this.ms?.readyState !== "open") return resolve();
        const done = () => {
          sb.removeEventListener("updateend", done);
          sb.removeEventListener("error", fail);
          resolve();
        };
        const fail = () => {
          sb.removeEventListener("updateend", done);
          sb.removeEventListener("error", fail);
          reject(new Error("SourceBuffer error"));
        };
        sb.addEventListener("updateend", done);
        sb.addEventListener("error", fail);
        try {
          fn(sb);
        } catch (e) {
          sb.removeEventListener("updateend", done);
          sb.removeEventListener("error", fail);
          reject(e);
          return;
        }
        if (!sb.updating) done();
      });
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

export { Unsupported as PlayerUnsupported };
