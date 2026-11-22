import { readBoxes } from "../../web/playback/mp4.ts";

/** One connected viewer, as the channel sees it. */
export interface Viewer {
  send(bytes: Uint8Array): void;
  /** Bytes sent but not yet taken by the client. */
  backlog(): number;
  /** The worker restarted: whatever was sent no longer continues. A viewer that stays subscribed gets a fresh init next. */
  restart(): void;
  /** Dropped by the channel (too slow, or the stream is gone). */
  close(): void;
}

export interface Init {
  bytes: Uint8Array;
  /** RFC 6381 codec strings of the tracks, e.g. ["avc1.640028"] */
  codecs: string[];
}

/**
 * What a newcomer needs before live fragments make sense to it.
 * `gop` is every fragment since the newest keyframe, so a newcomer starts decoding at once
 * while fragments stay short (about 200 ms) for low latency.
 */
type Feed =
  | { tag: "waiting" }
  | { tag: "init"; init: Init }
  | { tag: "live"; init: Init; gop: Uint8Array[] };

/**
 * Fan-out of one live worker's fMP4 output. Viewers start in `pending` and move to `active`
 * once they have been sent init plus the current GOP.
 */
export class Channel {
  private feed: Feed = { tag: "waiting" };
  private readonly pending = new Set<Viewer>();
  private readonly active = new Set<Viewer>();
  private readonly initWaiters = new Set<() => void>();
  /** Bumped per worker run so a late end of an old run cannot reset the new one. */
  private run = 0;
  /** On the clock passed in; never-seen compares as stalled whatever that clock reads. */
  lastFragmentAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly maxBacklog: number,
    private readonly now: () => number = Date.now,
  ) {}

  get viewers(): number {
    return this.pending.size + this.active.size;
  }

  get init(): Init | null {
    return this.feed.tag === "waiting" ? null : this.feed.init;
  }

  /** Resolves once an init is known or the signal aborts. */
  whenInit(signal: AbortSignal): Promise<Init | null> {
    if (this.init || signal.aborted) return Promise.resolve(this.init);
    return new Promise((resolve) => {
      const done = () => {
        this.initWaiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve(this.init);
      };
      this.initWaiters.add(done);
      signal.addEventListener("abort", done);
    });
  }

  add(v: Viewer): void {
    if (this.feed.tag === "live") this.prime(v, this.feed);
    else this.pending.add(v);
  }

  remove(v: Viewer): void {
    this.pending.delete(v);
    this.active.delete(v);
  }

  /** Starts a worker run; returns its token for `endRun`. */
  beginRun(): number {
    this.restartViewers();
    return ++this.run;
  }

  endRun(run: number): void {
    if (run === this.run) this.restartViewers();
  }

  setInit(run: number, init: Init): void {
    if (run !== this.run) return;
    if (this.feed.tag !== "waiting") this.restartViewers();
    this.feed = { tag: "init", init };
    for (const w of [...this.initWaiters]) w();
  }

  pushFragment(run: number, bytes: Uint8Array): void {
    if (run !== this.run || this.feed.tag === "waiting") return;
    this.lastFragmentAt = this.now();
    if (isSyncFragment(bytes)) {
      this.feed = { tag: "live", init: this.feed.init, gop: [bytes] };
    } else if (this.feed.tag === "live") {
      this.feed.gop.push(bytes);
    } else {
      return;
    }
    const feed = this.feed;
    for (const v of [...this.active]) this.deliver(v, bytes);
    for (const v of [...this.pending]) this.prime(v, feed);
  }

  /** Disconnects everyone; used when the stream no longer exists. */
  close(): void {
    for (const v of [...this.pending, ...this.active]) v.close();
    this.pending.clear();
    this.active.clear();
    for (const w of [...this.initWaiters]) w();
  }

  private prime(v: Viewer, feed: Extract<Feed, { tag: "live" }>): void {
    this.pending.delete(v);
    this.active.add(v);
    this.deliver(v, feed.init.bytes);
    for (const f of feed.gop) if (this.active.has(v)) this.deliver(v, f);
  }

  private deliver(v: Viewer, bytes: Uint8Array): void {
    v.send(bytes);
    if (v.backlog() <= this.maxBacklog) return;
    this.remove(v);
    v.close();
  }

  private restartViewers(): void {
    this.feed = { tag: "waiting" };
    for (const v of [...this.active]) {
      this.active.delete(v);
      this.pending.add(v);
      v.restart();
    }
  }
}

const SAMPLE_IS_NON_SYNC = 0x10000;

/**
 * True when the fragment's first sample is a keyframe. ffmpeg marks it with first-sample flags
 * in trun; otherwise per-sample or tfhd default flags apply. Unknown counts as sync, which is what
 * a keyframe-only fragmenter would produce.
 */
export function isSyncFragment(b: Uint8Array): boolean {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const moof = readBoxes(b).find((x) => x.type === "moof");
  const traf = moof && readBoxes(b, moof.body, moof.end).find((x) => x.type === "traf");
  if (!traf) return true;
  const kids = readBoxes(b, traf.body, traf.end);
  const tfhd = kids.find((x) => x.type === "tfhd");
  const trun = kids.find((x) => x.type === "trun");
  if (!trun) return true;
  const runFlags = dv.getUint32(trun.body) & 0xffffff;
  let p = trun.body + 8;
  if (runFlags & 0x01) p += 4;
  if (runFlags & 0x04) return !(dv.getUint32(p) & SAMPLE_IS_NON_SYNC);
  if (runFlags & 0x400) {
    if (runFlags & 0x100) p += 4;
    if (runFlags & 0x200) p += 4;
    return !(dv.getUint32(p) & SAMPLE_IS_NON_SYNC);
  }
  if (!tfhd) return true;
  const tfFlags = dv.getUint32(tfhd.body) & 0xffffff;
  if (!(tfFlags & 0x20)) return true;
  let q = tfhd.body + 8;
  for (const bit of [0x01, 0x02, 0x08, 0x10]) if (tfFlags & bit) q += bit === 0x01 ? 8 : 4;
  return !(dv.getUint32(q) & SAMPLE_IS_NON_SYNC);
}
