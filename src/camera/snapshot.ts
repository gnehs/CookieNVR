import type { Env } from "../env.ts";
import type { CameraId, Route } from "../types.ts";

export interface SnapshotOptions {
  env: Env;
  /** 回傳要擷取的 RTSP 網址；攝影機不存在或已停用時回 null */
  sourceUrl: (id: CameraId) => string | null;
  maxAgeMs?: number;
  timeoutMs?: number;
}

export interface Snapshots {
  get(id: CameraId): Promise<Uint8Array<ArrayBuffer> | null>;
  route(): Route;
}

interface Entry {
  jpeg: Uint8Array<ArrayBuffer> | null;
  at: number;
  pending: Promise<Uint8Array<ArrayBuffer> | null> | null;
}

/**
 * M3 的 detect worker 上線前的過渡做法：有人要快照時才啟動一次 ffmpeg 擷取一張。
 * 已有舊圖時先回舊圖並在背景更新，所以多宮格頁面不會被 ffmpeg 的啟動時間卡住。
 */
export function createSnapshots(opts: SnapshotOptions): Snapshots {
  const maxAgeMs = opts.maxAgeMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const entries = new Map<CameraId, Entry>();

  async function capture(url: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const proc = Bun.spawn(
      [
        opts.env.ffmpegBin, "-v", "error", "-nostdin", "-rtsp_transport", "tcp", "-i", url,
        "-frames:v", "1", "-vf", "scale=640:-2", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    try {
      const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      return (await proc.exited) === 0 && bytes.length > 0 ? bytes : null;
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh(id: CameraId, url: string, entry: Entry): Promise<Uint8Array<ArrayBuffer> | null> {
    entry.pending ??= capture(url)
      .catch(() => null)
      .then((jpeg) => {
        entry.pending = null;
        entry.at = Date.now();
        entry.jpeg = jpeg;
        return jpeg;
      });
    return entry.pending;
  }

  async function get(id: CameraId): Promise<Uint8Array<ArrayBuffer> | null> {
    const url = opts.sourceUrl(id);
    if (url === null) {
      entries.delete(id);
      return null;
    }
    let entry = entries.get(id);
    if (!entry) entries.set(id, (entry = { jpeg: null, at: 0, pending: null }));
    if (Date.now() - entry.at < maxAgeMs) return entry.jpeg;
    const fresh = refresh(id, url, entry);
    return entry.jpeg ?? fresh;
  }

  return {
    get,
    route: () => ({
      method: "GET",
      path: "/api/cameras/:id/snapshot.jpg",
      access: "user",
      async handler(ctx) {
        const jpeg = await get(ctx.params.id as CameraId);
        if (!jpeg) return Response.json({ error: "目前取不到畫面" }, { status: 503 });
        return new Response(jpeg, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
      },
    }),
  };
}
