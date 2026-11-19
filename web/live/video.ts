import { mimeType, type InitInfo, type Unit } from "../playback/mp4.ts";
import { mediaSourceCtor } from "../playback/player.ts";

export type LiveState =
  | { kind: "connecting" }
  | { kind: "playing" }
  /** no MediaSource at all, or the camera's codec (usually H.265) is not playable here */
  | { kind: "unsupported"; reason: "mse" | "codec"; codec: string | null }
  /** the camera has no live stream (disabled, deleted) */
  | { kind: "unavailable" };

/** How far behind the newest buffered frame the playhead may drift before we act. */
const SEEK_LAG_S = 1.5;
const CATCH_UP_LAG_S = 0.5;
const EDGE_S = 0.15;
const KEEP_BEHIND_S = 10;
/** Units queued while the SourceBuffer is busy; more than this means we are behind and should resync. */
const MAX_QUEUE = 40;

export function liveSupported(): boolean {
  return mediaSourceCtor() !== null;
}

/**
 * Plays one live fMP4 stream into a <video>: init then fragments, as they arrive.
 * Each `init` starts a fresh MediaSource, because a new worker run restarts timestamps.
 */
export class LiveVideo {
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  /** an init arrived and its MediaSource is opening; fragments queue up meanwhile */
  private opening = false;
  private queue: Uint8Array[] = [];
  private gen = 0;
  private timer: ReturnType<typeof setInterval>;
  private state: LiveState = { kind: "connecting" };
  private readonly onPlaying = () => this.sb && this.set({ kind: "playing" });

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onState: (s: LiveState) => void,
  ) {
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    // ManagedMediaSource (iPhone) only opens when AirPlay has no alternative source to switch to.
    video.disableRemotePlayback = true;
    video.addEventListener("playing", this.onPlaying);
    this.timer = setInterval(() => this.keepAtEdge(), 500);
  }

  get current(): LiveState {
    return this.state;
  }

  unit(u: Unit): void {
    if (this.state.kind === "unsupported") return;
    if (u.kind === "init") {
      void this.open(u.info, u.bytes);
      return;
    }
    if (!this.sb && !this.opening) return;
    this.queue.push(u.bytes);
    // Far behind (a busy or backgrounded tab): skip ahead to the newest data; the decoder resyncs at the next keyframe.
    if (this.queue.length > MAX_QUEUE) this.queue.splice(this.sb ? 0 : 1, this.queue.length - (this.sb ? 1 : 2));
    this.pump();
  }

  /** The stream ended or restarted; show the last frame until new data arrives. */
  reset(state: LiveState = { kind: "connecting" }): void {
    this.gen++;
    this.queue = [];
    this.sb = null;
    this.ms = null;
    this.opening = false;
    if (this.state.kind !== "unsupported") this.set(state);
  }

  destroy(): void {
    this.reset();
    clearInterval(this.timer);
    this.video.removeEventListener("playing", this.onPlaying);
    this.video.removeAttribute("src");
    this.video.load();
  }

  private set(s: LiveState): void {
    if (s.kind === this.state.kind) return;
    this.state = s;
    this.onState(s);
  }

  private async open(info: InitInfo, init: Uint8Array): Promise<void> {
    const Ctor = mediaSourceCtor();
    const mime = mimeType(info);
    const codec = info.tracks.find((t) => t.kind === "video")?.codec ?? null;
    if (!Ctor) return this.set({ kind: "unsupported", reason: "mse", codec });
    if (!mime || !Ctor.isTypeSupported(mime)) return this.set({ kind: "unsupported", reason: "codec", codec });
    const gen = ++this.gen;
    this.queue = [init];
    this.sb = null;
    this.opening = true;
    const ms = new Ctor();
    this.ms = ms;
    const url = URL.createObjectURL(ms);
    await new Promise<void>((resolve) => {
      ms.addEventListener("sourceopen", () => resolve(), { once: true });
      this.video.src = url;
    });
    URL.revokeObjectURL(url);
    if (gen !== this.gen) return;
    const sb = ms.addSourceBuffer(mime);
    sb.addEventListener("updateend", () => gen === this.gen && this.pump());
    this.sb = sb;
    this.opening = false;
    this.pump();
  }

  private pump(): void {
    const sb = this.sb;
    if (!sb || sb.updating || this.ms?.readyState !== "open") return;
    const next = this.queue.shift();
    if (next) {
      try {
        sb.appendBuffer(next as Uint8Array<ArrayBuffer>);
      } catch {
        // QuotaExceeded or a decode error: drop what is buffered and wait for the next keyframe via a reconnect.
        this.trim(true);
      }
      return;
    }
    this.trim(false);
  }

  /** Drops media far behind the playhead so the buffer stays small. */
  private trim(all: boolean): void {
    const sb = this.sb;
    const b = this.video.buffered;
    if (!sb || sb.updating || b.length === 0) return;
    const end = all ? this.video.currentTime - 1 : this.video.currentTime - KEEP_BEHIND_S;
    if (b.start(0) < end - 5 || (all && b.start(0) < end)) sb.remove(b.start(0), end);
  }

  private keepAtEdge(): void {
    const v = this.video;
    const b = v.buffered;
    if (!this.sb || b.length === 0) return;
    const end = b.end(b.length - 1);
    const lag = end - v.currentTime;
    if (lag > SEEK_LAG_S || v.currentTime < b.start(b.length - 1)) {
      v.currentTime = Math.max(b.start(b.length - 1), end - EDGE_S);
      v.playbackRate = 1;
    } else {
      // A slightly faster rate absorbs small drift without the stutter of a seek.
      v.playbackRate = lag > CATCH_UP_LAG_S ? 1.1 : 1;
    }
    if (v.paused) v.play().catch(() => {});
  }
}
