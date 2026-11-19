import { FrameKind, FrameReader } from "../../src/live/mux.ts";
import { Mp4Splitter } from "../playback/mp4.ts";
import { LiveVideo, liveSupported, type LiveState } from "./video.ts";

export type Quality = "sd" | "hd";

export interface LiveTarget {
  video: HTMLVideoElement;
  onState(s: LiveState): void;
}

type Outcome = "ended" | "gone";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Keeps a connection up while the page is visible: reconnects with backoff when it ends,
 * closes it while the tab is hidden, and reopens when it is shown again.
 */
function keepConnected(connect: (signal: AbortSignal) => Promise<Outcome>, onHidden: () => void): () => void {
  const stop = new AbortController();
  let current: AbortController | null = null;
  let wake: (() => void) | null = null;
  const onVisibility = () => {
    if (document.hidden) {
      current?.abort();
      onHidden();
    } else {
      wake?.();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  void (async () => {
    let failures = 0;
    while (!stop.signal.aborted) {
      if (document.hidden) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          stop.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
        failures = 0;
        continue;
      }
      current = new AbortController();
      const signal = AbortSignal.any([stop.signal, current.signal]);
      const startedAt = Date.now();
      const outcome = await connect(signal).catch((): Outcome => "ended");
      if (stop.signal.aborted) break;
      if (current.signal.aborted) continue;
      // A connection that streamed for a while was healthy; start the backoff over.
      failures = Date.now() - startedAt > 10_000 ? 0 : failures + 1;
      const delay = outcome === "gone" ? 15_000 : Math.min(500 * 2 ** failures, 10_000);
      await sleep(delay, AbortSignal.any([stop.signal, current.signal]));
    }
  })();

  return () => {
    stop.abort();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

async function readAll(res: Response, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onChunk(value);
  }
}

function unsupportedHere(targets: LiveTarget[]): boolean {
  if (liveSupported()) return false;
  for (const t of targets) t.onState({ kind: "unsupported", reason: "mse", codec: null });
  return true;
}

/** One camera over `GET /api/cameras/:id/live.mp4`. Returns a stop function. */
export function playSingle(cameraId: string, quality: Quality, target: LiveTarget): () => void {
  if (unsupportedHere([target])) return () => {};
  const lv = new LiveVideo(target.video, target.onState);
  const stop = keepConnected(
    async (signal) => {
      lv.reset();
      const res = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/live.mp4?quality=${quality}`, { signal, credentials: "same-origin" });
      if (res.status === 404) {
        lv.reset({ kind: "unavailable" });
        return "gone";
      }
      if (!res.ok || !res.body) return "ended";
      const splitter = new Mp4Splitter();
      await readAll(res, (chunk) => {
        for (const u of splitter.push(chunk)) lv.unit(u);
      });
      return "ended";
    },
    () => lv.reset(),
  );
  return () => {
    stop();
    lv.destroy();
  };
}

/** Several cameras over one `GET /api/live` connection, for the grid. Returns a stop function. */
export function playGrid(cameraIds: string[], quality: Quality, targets: LiveTarget[]): () => void {
  if (cameraIds.length === 0 || unsupportedHere(targets)) return () => {};
  const players = targets.map((t) => new LiveVideo(t.video, t.onState));
  const resetAll = () => players.forEach((p) => p.reset());
  const stop = keepConnected(
    async (signal) => {
      resetAll();
      const ids = cameraIds.map(encodeURIComponent).join(",");
      const res = await fetch(`/api/live?cameras=${ids}&quality=${quality}`, { signal, credentials: "same-origin" });
      if (!res.ok || !res.body) return "ended";
      const splitters = players.map(() => new Mp4Splitter());
      const frames = new FrameReader();
      await readAll(res, (chunk) => {
        for (const f of frames.push(chunk)) {
          const p = players[f.index];
          if (!p) continue;
          if (f.kind === FrameKind.data) {
            for (const u of splitters[f.index]!.push(f.payload)) p.unit(u);
          } else if (f.kind === FrameKind.restart) {
            splitters[f.index] = new Mp4Splitter();
            p.reset();
          } else if (f.kind === FrameKind.gone) {
            p.reset({ kind: "unavailable" });
          }
        }
      });
      return "ended";
    },
    resetAll,
  );
  return () => {
    stop();
    players.forEach((p) => p.destroy());
  };
}
