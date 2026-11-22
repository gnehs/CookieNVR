import { Mp4Splitter } from "../../web/playback/mp4.ts";
import type { Env } from "../env.ts";
import { HttpError } from "../http/errors.ts";
import type { CameraId, Route, StreamName, WorkerSpec } from "../types.ts";
import { Channel, type Viewer } from "./channel.ts";
import { encodeFrame, FrameKind } from "./mux.ts";
import { queuedStream } from "../stream/queued-stream.ts";
import { msg } from "../messages/index.ts";

export type Quality = "sd" | "hd";

export interface LiveSource {
  stream: StreamName;
  /** RTSP URL the live worker reads, normally the restream path */
  url: string;
}

export interface LiveOptions {
  env: Pick<Env, "ffmpegBin">;
  /** null when the camera does not exist or is disabled */
  source(id: CameraId, quality: Quality): LiveSource | null;
  /** The set of live workers to run changed: call `workerSpecs()` and apply. */
  onChange(): void;
  /** How long a stream stays up after its last viewer leaves. */
  lingerMs?: number;
  maxBacklogBytes?: number;
  /** How long a new viewer of a stopped stream waits for the worker's first output. */
  initTimeoutMs?: number;
  /** Fragment silence after which the worker counts as stalled. */
  stallMs?: number;
  now?: () => number;
}

export interface Watch {
  channel: Channel;
  stop(): void;
}

export interface Live {
  /** null when there is nothing to watch. */
  watch(id: CameraId, quality: Quality, viewer: Viewer): Watch | null;
  workerSpecs(): WorkerSpec[];
  /** Live worker id → number of viewers, for diagnostics and tests. */
  viewers(): Map<string, number>;
  routes(): Route[];
}

/** A stream that someone watches, or watched less than `lingerMs` ago. */
interface Entry {
  cameraId: CameraId;
  source: LiveSource;
  channel: Channel;
  linger: ReturnType<typeof setTimeout> | null;
}

const MAX_MUX_CAMERAS = 32;
const PING_MS = 20_000;

const workerId = (id: CameraId, stream: StreamName) => `live:${id}:${stream}`;
const qualityOf = (stream: StreamName): Quality => (stream === "main" ? "hd" : "sd");

export function parseQuality(raw: string | null): Quality {
  if (raw === null || raw === "sd") return "sd";
  if (raw === "hd") return "hd";
  throw new HttpError(400, msg("field.oneOf", { path: "quality", values: ["sd", "hd"] }));
}

export function liveCommand(ffmpegBin: string, url: string): string[] {
  return [
    ffmpegBin,
    ...["-hide_banner", "-nostdin", "-loglevel", "warning"],
    // Codec parameters come with the RTSP SDP, so a short probe is enough and saves ~2 s per start.
    ...["-fflags", "nobuffer", "-probesize", "500000", "-analyzeduration", "500000"],
    ...["-rtsp_transport", "tcp", "-timeout", "10000000"],
    ...["-i", url],
    ...["-map", "0:v:0", "-an", "-c:v", "copy"],
    ...["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"],
    // Fragments every 200 ms instead of once per keyframe: latency follows the fragment, not the GOP.
    ...["-frag_duration", "200000", "-flush_packets", "1"],
    "pipe:1",
  ];
}

/** Feeds one worker run's stdout into its channel. */
export async function pumpRun(channel: Channel, stdout: ReadableStream<Uint8Array>): Promise<void> {
  const run = channel.beginRun();
  const splitter = new Mp4Splitter();
  try {
    const reader = stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const unit of splitter.push(value)) {
        if (unit.kind === "init") {
          const codecs = unit.info.tracks.flatMap((t) => (t.codec ? [t.codec] : []));
          channel.setInit(run, { bytes: unit.bytes, codecs });
        } else {
          channel.pushFragment(run, unit.bytes);
        }
      }
    }
  } finally {
    channel.endRun(run);
  }
}

export function createLive(opts: LiveOptions): Live {
  const lingerMs = opts.lingerMs ?? 30_000;
  const maxBacklog = opts.maxBacklogBytes ?? 4 * 1024 * 1024;
  const initTimeoutMs = opts.initTimeoutMs ?? 20_000;
  const stallMs = opts.stallMs ?? 15_000;
  // 只用來判斷串流有沒有卡住，所以用單調時鐘：系統時間被往回調時，卡住的 worker 不會被當成正常
  const now = opts.now ?? (() => performance.now());
  const entries = new Map<string, Entry>();

  function drop(key: string, entry: Entry): void {
    if (entry.linger) clearTimeout(entry.linger);
    entries.delete(key);
    entry.channel.close();
  }

  function watch(id: CameraId, quality: Quality, viewer: Viewer): Watch | null {
    const source = opts.source(id, quality);
    if (!source) return null;
    const key = workerId(id, source.stream);
    let entry = entries.get(key);
    if (entry && entry.source.url !== source.url) {
      drop(key, entry);
      entry = undefined;
    }
    const isNew = !entry;
    if (!entry) {
      entry = { cameraId: id, source, channel: new Channel(maxBacklog, now), linger: null };
      entries.set(key, entry);
    }
    if (entry.linger) clearTimeout(entry.linger);
    entry.linger = null;
    entry.channel.add(viewer);
    if (isNew) opts.onChange();

    const e = entry;
    let stopped = false;
    return {
      channel: e.channel,
      stop() {
        if (stopped) return;
        stopped = true;
        e.channel.remove(viewer);
        if (e.channel.viewers > 0 || e.linger || entries.get(key) !== e) return;
        e.linger = setTimeout(() => {
          if (entries.get(key) !== e || e.channel.viewers > 0) return;
          drop(key, e);
          opts.onChange();
        }, lingerMs);
      },
    };
  }

  function workerSpecs(): WorkerSpec[] {
    const specs: WorkerSpec[] = [];
    for (const [key, entry] of entries) {
      const current = opts.source(entry.cameraId, qualityOf(entry.source.stream));
      if (!current || current.stream !== entry.source.stream || current.url !== entry.source.url) {
        drop(key, entry);
        continue;
      }
      const { channel } = entry;
      specs.push({
        id: key,
        kind: "live",
        cmd: liveCommand(opts.env.ffmpegBin, entry.source.url),
        stall: { graceMs: stallMs, intervalMs: 5_000, healthy: () => now() - channel.lastFragmentAt < stallMs },
        readStdout: (stdout) => pumpRun(channel, stdout),
      });
    }
    return specs;
  }

  const single: Route = {
    method: "GET",
    path: "/api/cameras/:id/live.mp4",
    access: "user",
    async handler(ctx) {
      const quality = parseQuality(ctx.url.searchParams.get("quality"));
      let w: Watch | null = null;
      const q = queuedStream(maxBacklog, () => w?.stop());
      w = watch(ctx.params.id as CameraId, quality, {
        send: q.enqueue,
        backlog: q.backlog,
        // One response carries one run; the client reconnects for the next.
        restart: q.abort,
        close: q.abort,
      });
      if (!w) throw new HttpError(404, msg("live.noStream"));
      const init = await w.channel.whenInit(AbortSignal.any([ctx.req.signal, AbortSignal.timeout(initTimeoutMs)]));
      if (!init || !q.open) {
        q.abort();
        throw new HttpError(503, msg("live.noFrame"));
      }
      return new Response(q.stream, {
        headers: { "content-type": "video/mp4", "x-codec": init.codecs.join(","), "cache-control": "no-store" },
      });
    },
  };

  const mux: Route = {
    method: "GET",
    path: "/api/live",
    access: "user",
    handler(ctx) {
      const quality = parseQuality(ctx.url.searchParams.get("quality"));
      const ids = (ctx.url.searchParams.get("cameras") ?? "").split(",").filter(Boolean);
      if (ids.length === 0 || ids.length > MAX_MUX_CAMERAS) throw new HttpError(400, msg("live.cameraCount", { max: MAX_MUX_CAMERAS }));
      const watches: (Watch | null)[] = [];
      let ping: ReturnType<typeof setInterval> | undefined;
      const stopAll = () => {
        clearInterval(ping);
        for (const w of watches) w?.stop();
      };
      const q = queuedStream(maxBacklog, stopAll);
      ids.forEach((id, i) => {
        const w = watch(id as CameraId, quality, {
          send: (b) => q.enqueue(encodeFrame(FrameKind.data, i, b)),
          backlog: q.backlog,
          restart: () => q.enqueue(encodeFrame(FrameKind.restart, i)),
          close: () => (q.backlog() > maxBacklog ? q.abort() : q.enqueue(encodeFrame(FrameKind.gone, i))),
        });
        watches.push(w);
        if (!w) q.enqueue(encodeFrame(FrameKind.gone, i));
      });
      ping = setInterval(() => q.enqueue(encodeFrame(FrameKind.ping, 0)), PING_MS);
      return new Response(q.stream, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
    },
  };

  return {
    watch,
    workerSpecs,
    viewers: () => new Map([...entries].map(([k, e]) => [k, e.channel.viewers])),
    routes: () => [single, mux],
  };
}
