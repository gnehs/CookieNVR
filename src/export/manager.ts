import type { Database } from "bun:sqlite";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExportDto, ExportRequestDto } from "../api-types.ts";
import type { Env } from "../env.ts";
import { msg, zh, type Msg } from "../messages/index.ts";
import { getSegment, segmentsInRange } from "../recording/store.ts";
import type { CameraId, CameraStore } from "../types.ts";
import { processStartToken, reapOrphans, signalGroup, writePidFile } from "../workers/process-group.ts";
import { exportFileName } from "./filename.ts";
import type { BoxSample } from "../events/store.ts";
import { overlayBoxes, overlayFilter } from "./overlay.ts";
import { planExport, type ExportPlan, type PlanPart } from "./plan.ts";

export const EXPORT_TIMEOUT_MS = 10 * 60_000;
export const EXPORT_TTL_MS = 24 * 60 * 60_000;
export const MAX_LIVE_JOBS = 10;

/** Why a request was refused; routes map each to an HTTP status. */
export class ExportError extends Error {
  constructor(
    readonly kind: "not-found" | "invalid" | "empty" | "busy" | "disk",
    readonly msg: Msg,
  ) {
    super(zh(msg));
  }
}

export interface ExportsOptions {
  db: Database;
  cameras: Pick<CameraStore, "get">;
  env: Pick<Env, "ffmpegBin" | "ffprobeBin">;
  /** Job files live under `<dir>/<job id>/`; the whole directory is wiped on start. */
  dir: string;
  /** Records the running ffmpeg so a crashed main process's leftover is killed on the next start. */
  pidFile: string;
  freeBytes: () => Promise<number>;
  now?: () => number;
  timeoutMs?: number;
  killGraceMs?: number;
  ttlMs?: number;
}

type Phase =
  | { tag: "queued" }
  | { tag: "running"; progress: number }
  | { tag: "done"; finishedAt: number; sizeBytes: number }
  | { tag: "failed"; finishedAt: number; error: Msg };

interface Job {
  id: string;
  cameraId: CameraId;
  cameraName: string;
  startMs: number;
  endMs: number;
  tz: string;
  fileName: string;
  createdAt: number;
  durationMs: number;
  estimatedBytes: number;
  includesRecording: boolean;
  /** Detections to burn into the clip; null = a plain copy of the recording. */
  boxes: readonly BoxSample[] | null;
  phase: Phase;
}

export interface Exports {
  /** Resolves once leftovers of a previous run are gone; create and list work before that, but nothing starts. */
  readonly ready: Promise<void>;
  /** boxes: detections to draw, which re-encodes the clip; without them the recording is copied as is. */
  create(request: ExportRequestDto, opts?: { boxes?: readonly BoxSample[] }): Promise<ExportDto>;
  list(): ExportDto[];
  get(id: string): ExportDto | null;
  /** The finished file, or null while the job is not done. */
  file(id: string): { path: string; fileName: string; sizeBytes: number } | null;
  /** Cancels a queued or running job, or dismisses a finished one. */
  remove(id: string): boolean;
  /** Removes finished jobs older than the retention period. */
  sweep(): Promise<void>;
  /** Pid of the ffmpeg now running, for the memory monitor. */
  activePid(): number | null;
  /** Fails the running job because its ffmpeg used too much memory. */
  killForMemory(): void;
  shutdown(): Promise<void>;
}

const pad = (n: number) => n.toString(16).padStart(2, "0");
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(pad).join("");

const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;
const secs = (ms: number) => (ms / 1000).toFixed(3);

/**
 * exactEnds: every part ends at its planned length even when it runs to the end of the file. Without it the concat
 * demuxer starts the next file where this one's longest stream ends, which drifts from the plan by a few frames per
 * file; drawn boxes are timed by the plan.
 */
export function concatList(files: { path: string; part: PlanPart }[], exactEnds = false): string {
  const lines = ["ffconcat version 1.0"];
  for (const { path, part } of files) {
    lines.push(`file ${quote(path)}`);
    if (part.inpointMs > 0) lines.push(`inpoint ${secs(part.inpointMs)}`);
    const outpointMs = part.outpointMs ?? (exactEnds ? part.inpointMs + part.coveredMs : null);
    if (outpointMs !== null) lines.push(`outpoint ${secs(outpointMs)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function createExports(opts: ExportsOptions): Exports {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? EXPORT_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? 3_000;
  const ttlMs = opts.ttlMs ?? EXPORT_TTL_MS;

  const jobs = new Map<string, Job>();
  /** Queue order; a job leaves it when it starts. */
  const queue: string[] = [];
  let current: { job: Job; pid: number | null; stop: (error: Msg | null) => void } | null = null;
  let closed = false;

  const ready = (async () => {
    await reapOrphans(opts.pidFile, killGraceMs).catch(() => []);
    await rm(opts.dir, { recursive: true, force: true });
    await mkdir(opts.dir, { recursive: true });
  })();
  void ready.then(pump);

  const dirOf = (job: Job) => join(opts.dir, job.id);
  const outPath = (job: Job) => join(dirOf(job), "export.mp4");

  function toDto(job: Job): ExportDto {
    const p = job.phase;
    const finishedAt = p.tag === "done" || p.tag === "failed" ? p.finishedAt : null;
    return {
      id: job.id,
      cameraId: job.cameraId,
      cameraName: job.cameraName,
      startMs: job.startMs,
      endMs: job.endMs,
      durationMs: job.durationMs,
      estimatedBytes: job.estimatedBytes,
      includesRecording: job.includesRecording,
      state: p.tag,
      progress: p.tag === "done" ? 1 : p.tag === "running" ? p.progress : 0,
      ahead: p.tag === "queued" ? queue.indexOf(job.id) + (current ? 1 : 0) : null,
      sizeBytes: p.tag === "done" ? p.sizeBytes : null,
      error: p.tag === "failed" ? zh(p.error) : null,
      errorMsg: p.tag === "failed" ? p.error : null,
      fileName: job.fileName,
      createdAt: job.createdAt,
      finishedAt,
      expiresAt: finishedAt === null ? null : finishedAt + ttlMs,
    };
  }

  function planFor(request: ExportRequestDto): ExportPlan {
    const segments = segmentsInRange(opts.db, request.cameraId, request.startMs, Math.min(request.endMs, now()));
    return planExport(segments, request.startMs, request.endMs, now());
  }

  async function create(request: ExportRequestDto, createOpts: { boxes?: readonly BoxSample[] } = {}): Promise<ExportDto> {
    if (closed) throw new ExportError("busy", msg("export.shuttingDown"));
    const camera = opts.cameras.get(request.cameraId);
    if (!camera) throw new ExportError("not-found", msg("export.cameraNotFound"));
    const plan = planFor(request);
    if (!plan.ok) throw new ExportError(plan.reason === "empty" ? "empty" : "invalid", plan.msg);
    const live = [...jobs.values()].filter((j) => j.phase.tag === "queued" || j.phase.tag === "running").length;
    if (live >= MAX_LIVE_JOBS) throw new ExportError("busy", msg("export.queueFull"));
    if (plan.estimatedBytes > (await opts.freeBytes())) throw new ExportError("disk", msg("export.diskFull"));

    const tz = request.tz ?? "UTC";
    const job: Job = {
      id: newId(),
      cameraId: camera.id,
      cameraName: camera.config.name,
      startMs: plan.startMs,
      endMs: plan.endMs,
      tz,
      fileName: exportFileName(camera.config.name, plan.startMs, tz),
      createdAt: now(),
      durationMs: plan.durationMs,
      estimatedBytes: plan.estimatedBytes,
      includesRecording: plan.includesRecording,
      boxes: createOpts.boxes?.length ? createOpts.boxes : null,
      phase: { tag: "queued" },
    };
    jobs.set(job.id, job);
    queue.push(job.id);
    void ready.then(pump);
    return toDto(job);
  }

  function pump(): void {
    if (closed || current) return;
    const id = queue.shift();
    const job = id === undefined ? undefined : jobs.get(id);
    if (!job) {
      if (queue.length > 0) pump();
      return;
    }
    job.phase = { tag: "running", progress: 0 };
    const run = { job, pid: null as number | null, stop: (_e: Msg | null) => {} };
    current = run;
    void execute(job, run)
      .catch((e) => fail(job, e instanceof ExportError ? e.msg : msg("export.failed"), e))
      .finally(() => {
        if (current === run) current = null;
        pump();
      });
  }

  function fail(job: Job, error: Msg, cause?: unknown): void {
    if (!jobs.has(job.id) || job.phase.tag === "failed") return;
    if (cause !== undefined && !(cause instanceof ExportError)) console.error(`[export] ${job.id}`, cause);
    job.phase = { tag: "failed", finishedAt: now(), error };
    void rm(dirOf(job), { recursive: true, force: true });
  }

  /** Copies the bytes of a segment that is still being written, so ffmpeg reads a file that stops growing. */
  async function stage(job: Job, parts: PlanPart[]): Promise<{ path: string; part: PlanPart }[]> {
    const dir = dirOf(job);
    await mkdir(dir, { recursive: true });
    const files: { path: string; part: PlanPart }[] = [];
    for (const part of parts) {
      const seg = getSegment(opts.db, part.segmentId);
      if (!seg) continue;
      const size = await stat(seg.path).then((s) => s.size, () => null);
      // A segment that retention removed meanwhile is a gap like any other.
      if (size === null) continue;
      if (part.open) {
        const copy = join(dir, `open-${seg.id}.mp4`);
        await Bun.write(copy, Bun.file(seg.path).slice(0, size));
        files.push({ path: copy, part });
      } else {
        files.push({ path: seg.path, part });
      }
    }
    return files;
  }

  async function execute(job: Job, run: NonNullable<typeof current>): Promise<void> {
    if (job.phase.tag !== "running") return;
    // Re-plan: segments may have closed or been deleted while the job waited in the queue.
    const plan = planFor({ cameraId: job.cameraId, startMs: job.startMs, endMs: job.endMs });
    if (!plan.ok) throw new ExportError("empty", msg("export.purged"));
    const files = await stage(job, plan.parts);
    if (files.length === 0) throw new ExportError("empty", msg("export.purged"));
    const dir = dirOf(job);
    const overlay = job.boxes ? overlayBoxes(job.boxes, files.map((f) => f.part)) : [];
    const listPath = join(dir, "list.txt");
    await Bun.write(listPath, concatList(files, overlay.length > 0));
    const partial = join(dir, "export.partial.mp4");
    const expectedMs = files.reduce((n, f) => n + f.part.coveredMs, 0);
    const filterPath = join(dir, "boxes.filter");
    if (overlay.length) await Bun.write(filterPath, overlayFilter(overlay));
    // Drawing boxes is the one place an export re-encodes; -copyts keeps the timeline overlayFilter expects.
    // Two threads each way and a short lookahead keep a 4K HEVC source at about 275 MB (measured), where the defaults
    // took 760 MB on 18 cores.
    const codec = overlay.length
      ? [
          ...["-/filter:v", filterPath, "-af", "atrim=start=0,asetpts=PTS-STARTPTS"],
          ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-threads", "2", "-x264-params", "rc-lookahead=10", "-c:a", "aac"],
        ]
      : ["-c", "copy"];

    const proc = Bun.spawn(
      [
        opts.env.ffmpegBin,
        ...["-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1"],
        ...(overlay.length ? ["-copyts", "-threads", "2"] : []),
        ...["-f", "concat", "-safe", "0", "-i", listPath],
        ...codec,
        ...["-movflags", "+faststart", "-f", "mp4", "-y", partial],
      ],
      { detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    run.pid = proc.pid;
    const token = processStartToken(proc.pid);
    if (token) writePidFile(opts.pidFile, [{ id: `export:${job.id}`, pid: proc.pid, startToken: token }]);

    let stopReason: Msg | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = (reason: Msg | null) => {
      if (stopReason !== null || killTimer) return;
      stopReason = reason ?? msg("export.cancelled");
      signalGroup(proc.pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(proc.pid, "SIGKILL"), killGraceMs);
    };
    run.stop = terminate;
    const deadline = setTimeout(() => terminate(msg("export.timedOut")), timeoutMs);

    const stderrTail: string[] = [];
    const readStderr = (async () => {
      await eachChunk(proc.stderr, (chunk) => {
        stderrTail.push(...new TextDecoder().decode(chunk).split(/\r?\n/).filter(Boolean));
        if (stderrTail.length > 30) stderrTail.splice(0, stderrTail.length - 30);
      });
    })();
    const readProgress = (async () => {
      let partial = "";
      const decoder = new TextDecoder();
      await eachChunk(proc.stdout, (chunk) => {
        const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          const us = /^out_time_us=(\d+)$/.exec(line)?.[1];
          if (us !== undefined && job.phase.tag === "running" && expectedMs > 0) {
            job.phase.progress = Math.min(0.99, Number(us) / 1000 / expectedMs);
          }
        }
      });
    })();

    const code = await proc.exited;
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    signalGroup(proc.pid, "SIGKILL");
    await Promise.all([readStderr, readProgress]).catch(() => {});
    writePidFile(opts.pidFile, []);
    run.pid = null;

    if (!jobs.has(job.id)) {
      await rm(dir, { recursive: true, force: true });
      return;
    }
    if (stopReason !== null) throw new ExportError("busy", stopReason);
    if (code !== 0) {
      console.error(`[export] ${job.id} ffmpeg exited ${code}\n${stderrTail.join("\n")}`);
      throw new ExportError("busy", msg("export.failed"));
    }
    const size = await stat(partial).then((s) => s.size, () => 0);
    if (size === 0 || (await probeDuration(opts.env.ffprobeBin, partial)) <= 0) {
      throw new ExportError("busy", msg("export.unplayable"));
    }
    await rename(partial, outPath(job));
    await Promise.all([rm(listPath, { force: true }), rm(filterPath, { force: true }), ...files.filter((f) => f.part.open).map((f) => rm(f.path, { force: true }))]);
    job.phase = { tag: "done", finishedAt: now(), sizeBytes: size };
  }

  return {
    ready,
    create,
    list: () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(toDto),
    get: (id) => {
      const job = jobs.get(id);
      return job ? toDto(job) : null;
    },
    file(id) {
      const job = jobs.get(id);
      if (!job || job.phase.tag !== "done") return null;
      return { path: outPath(job), fileName: job.fileName, sizeBytes: job.phase.sizeBytes };
    },
    remove(id) {
      const job = jobs.get(id);
      if (!job) return false;
      jobs.delete(id);
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
      if (current?.job === job) current.stop(null);
      else void rm(dirOf(job), { recursive: true, force: true });
      return true;
    },
    async sweep() {
      const cutoff = now() - ttlMs;
      for (const job of [...jobs.values()]) {
        const p = job.phase;
        if ((p.tag === "done" || p.tag === "failed") && p.finishedAt <= cutoff) {
          jobs.delete(job.id);
          await rm(dirOf(job), { recursive: true, force: true });
        }
      }
    },
    activePid: () => current?.pid ?? null,
    killForMemory() {
      current?.stop(msg("export.memory"));
    },
    async shutdown() {
      closed = true;
      queue.length = 0;
      const running = current;
      running?.stop(null);
      while (current) await Bun.sleep(20);
      await ready;
    },
  };
}

async function probeDuration(ffprobe: string, path: string): Promise<number> {
  const proc = Bun.spawn([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const seconds = Number(text.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

async function eachChunk(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(value);
    }
  } catch {
    // The pipe closes with the process.
  }
}
