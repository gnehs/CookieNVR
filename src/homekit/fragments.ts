/**
 * fMP4 bookkeeping for HomeKit Secure Video. The recording ffmpeg cuts one fragment per keyframe
 * (`frag_keyframe`), so every fragment starts with a keyframe as HKSV requires; the prebuffer keeps
 * the newest ones covering at least `lengthMs`, and each recording stream is a queue that starts
 * with init + prebuffer and then follows the live fragments.
 */

export interface Fragment {
  bytes: Uint8Array;
  /** Media duration in ms, from the fragment's own timestamps. */
  durationMs: number;
}

export class Prebuffer {
  private initBytes: Uint8Array | null = null;
  private frags: Fragment[] = [];
  private readonly streams = new Set<RecordingStream>();

  constructor(private readonly lengthMs: number) {}

  get init(): Uint8Array | null {
    return this.initBytes;
  }

  /** Media currently held, in ms. */
  get bufferedMs(): number {
    return this.frags.reduce((a, f) => a + f.durationMs, 0);
  }

  /** A new ffmpeg run: its fragments do not continue the previous run's timeline. */
  setInit(bytes: Uint8Array): void {
    this.initBytes = bytes;
    this.frags = [];
    for (const s of this.streams) s.end("source-restarted");
  }

  push(fragment: Fragment): void {
    if (!this.initBytes) return;
    this.frags.push(fragment);
    // Drop the oldest while the rest still covers the prebuffer length.
    while (this.frags.length > 1 && this.bufferedMs - this.frags[0]!.durationMs >= this.lengthMs) this.frags.shift();
    for (const s of this.streams) s.offer(fragment);
  }

  /** Stops feeding open streams, e.g. when recording is switched off. */
  reset(): void {
    this.initBytes = null;
    this.frags = [];
    for (const s of this.streams) s.end("source-stopped");
  }

  /** null when there is no init yet: nothing to send. */
  open(maxQueuedBytes: number): RecordingStream | null {
    if (!this.initBytes) return null;
    const stream = new RecordingStream(maxQueuedBytes, () => this.streams.delete(stream));
    stream.offerInit(this.initBytes);
    for (const f of this.frags) stream.offer(f);
    this.streams.add(stream);
    return stream;
  }
}

export type StreamEnd = "closed" | "source-restarted" | "source-stopped" | "overflow";

/** One recording stream request: packets in order, the first is always the init segment. */
export class RecordingStream {
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private waiter: (() => void) | null = null;
  private ended: StreamEnd | null = null;
  sentPackets = 0;
  /** Fragments longer than the selected HKSV fragment length (camera keyframe interval too long). */
  oversized = 0;
  private maxFragmentMs = Infinity;

  constructor(
    private readonly maxQueuedBytes: number,
    private readonly detach: () => void,
  ) {}

  get endReason(): StreamEnd | null {
    return this.ended;
  }

  setMaxFragmentMs(ms: number): void {
    this.maxFragmentMs = ms;
  }

  offerInit(bytes: Uint8Array): void {
    this.enqueue(bytes);
  }

  offer(f: Fragment): void {
    if (this.ended) return;
    if (f.durationMs > this.maxFragmentMs) this.oversized++;
    this.enqueue(f.bytes);
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.ended) return;
    if (this.queuedBytes + bytes.byteLength > this.maxQueuedBytes) {
      this.end("overflow");
      return;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.byteLength;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  end(reason: StreamEnd): void {
    if (this.ended) return;
    this.ended = reason;
    this.detach();
    this.wake();
  }

  /** Next packet, or null once the stream ended and the queue drained (overflow drops the queue). */
  async next(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.ended === "overflow") return null;
      const item = this.queue.shift();
      if (item) {
        this.queuedBytes -= item.byteLength;
        this.sentPackets++;
        return item;
      }
      if (this.ended) return null;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}
