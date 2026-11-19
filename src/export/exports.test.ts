import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportDto } from "../api-types.ts";
import { openDb } from "../db.ts";
import { createRouter } from "../http/router.ts";
import type { CameraId, Principal } from "../types.ts";
import { createExports, type Exports, type ExportsOptions } from "./manager.ts";
import { exportRoutes } from "./routes.ts";
import { addSegment, makeClip, probe } from "./test-helpers.ts";

const T = Date.UTC(2026, 10, 19, 8, 0, 0);
const CAM = "cam1" as CameraId;
const root = mkdtempSync(join(tmpdir(), "cookienvr-exp-"));
const clip10 = join(root, "clip10.mp4");
const clipSilent = join(root, "silent10.mp4");
let db: Database;
const made: Exports[] = [];
let seq = 0;

beforeAll(async () => {
  await makeClip(clip10, 10);
  await makeClip(clipSilent, 10, { audio: false });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(made.splice(0).map((e) => e.shutdown()));
});

/** Three 10 s segments: [0,10), [10,20) and, after a 20 s gap, [40,50). */
function seed(extra?: (db: Database, dir: string) => void): { dir: string } {
  db = openDb(":memory:");
  const dir = join(root, `rec${++seq}`);
  const size = statSync(clip10).size;
  addSegment(db, CAM, clip10, join(dir, "a.mp4"), T, T + 10_000, size);
  addSegment(db, CAM, clip10, join(dir, "b.mp4"), T + 10_000, T + 20_000, size);
  addSegment(db, CAM, clip10, join(dir, "c.mp4"), T + 40_000, T + 50_000, size);
  extra?.(db, dir);
  return { dir };
}

function make(overrides: Partial<ExportsOptions> = {}, now = T + 5 * 3_600_000): Exports {
  const dir = join(root, `exp${++seq}`);
  const exports = createExports({
    db,
    cameras: { get: (id) => (id === CAM ? ({ id: CAM, config: { name: "客廳" } } as never) : null) },
    env: { ffmpegBin: "ffmpeg", ffprobeBin: "ffprobe" },
    dir,
    pidFile: join(root, `pid${seq}.json`),
    freeBytes: async () => 10 ** 12,
    now: () => now,
    killGraceMs: 200,
    ...overrides,
  });
  made.push(exports);
  return exports;
}

async function finished(exports: Exports, id: string, timeoutMs = 20_000): Promise<ExportDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dto = exports.get(id);
    if (dto && (dto.state === "done" || dto.state === "failed")) return dto;
    if (Date.now() > deadline) throw new Error(`export still ${dto?.state}`);
    await Bun.sleep(20);
  }
}

describe("export manager", () => {
  test("a range across a gap becomes one playable MP4 with video and audio and only the recorded time", async () => {
    seed();
    const exports = make();
    const job = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 50_000, tz: "Asia/Taipei" });
    expect(job.durationMs).toBe(30_000);
    const done = await finished(exports, job.id);
    expect(done.error).toBeNull();
    expect(done.state).toBe("done");
    const file = exports.file(job.id)!;
    const p = await probe(file.path);
    expect(p.video?.codec).toBe("h264");
    expect(p.audio?.codec).toBe("aac");
    expect(Math.abs(p.durationS - 30)).toBeLessThan(0.5);
    expect(done.sizeBytes).toBe(statSync(file.path).size);
    expect(file.fileName).toBe("客廳_20261119-160000.mp4");
    const head = Buffer.from(await Bun.file(file.path).slice(0, 4096).arrayBuffer());
    // +faststart puts moov ahead of mdat
    expect(head.indexOf("moov")).toBeGreaterThan(-1);
    expect(head.indexOf("mdat")).toBe(-1);
  }, 30_000);

  test("trimmed ends land on a keyframe, within one GOP (1 s here) of the request", async () => {
    seed();
    const exports = make();
    const job = await exports.create({ cameraId: CAM, startMs: T + 3_300, endMs: T + 17_300 });
    expect((await finished(exports, job.id)).state).toBe("done");
    const { durationS } = await probe(exports.file(job.id)!.path);
    expect(durationS).toBeGreaterThanOrEqual(14 - 0.1);
    expect(durationS).toBeLessThanOrEqual(14 + 1.5);
  }, 30_000);

  test("a segment still being written is exported as far as it is on disk, even cut mid-fragment", async () => {
    const { dir } = seed();
    const open = join(dir, "d.mp4");
    addSegment(db, CAM, clip10, open, T + 60_000, null, 0);
    truncateSync(open, Math.floor(statSync(clip10).size * 0.55));
    const exports = make({}, T + 75_000);
    const job = await exports.create({ cameraId: CAM, startMs: T + 40_000, endMs: T + 200_000 });
    expect(job.includesRecording).toBe(true);
    expect(job.endMs).toBe(T + 75_000);
    const done = await finished(exports, job.id);
    expect(done.error).toBeNull();
    const { durationS } = await probe(exports.file(job.id)!.path);
    expect(durationS).toBeGreaterThan(10 + 3);
    expect(durationS).toBeLessThan(10 + 10);
    expect(readdirSync(join(root, "exp" + seq)).flatMap((d) => readdirSync(join(root, "exp" + seq, d)))).toEqual(["export.mp4"]);
  }, 30_000);

  test("a silent camera exports video only without complaint", async () => {
    db = openDb(":memory:");
    addSegment(db, CAM, clipSilent, join(root, `silent${++seq}`, "a.mp4"), T, T + 10_000, 1000);
    const exports = make();
    const job = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 10_000 });
    expect((await finished(exports, job.id)).state).toBe("done");
    expect((await probe(exports.file(job.id)!.path)).audio).toBeNull();
  }, 30_000);

  test("refuses unknown cameras, empty ranges, over two hours, and a full disk with clear errors", async () => {
    seed();
    const exports = make({ freeBytes: async () => 1000 });
    const bad = (req: { cameraId: string; startMs: number; endMs: number }) =>
      exports.create({ ...req, cameraId: req.cameraId as CameraId }).then(
        () => null,
        (e: Error & { kind: string }) => ({ kind: e.kind, message: e.message }),
      );
    expect(await bad({ cameraId: "nope", startMs: T, endMs: T + 5000 })).toMatchObject({ kind: "not-found" });
    expect(await bad({ cameraId: CAM, startMs: T + 20_000, endMs: T + 30_000 })).toEqual({ kind: "empty", message: "這段時間沒有錄影" });
    expect(await bad({ cameraId: CAM, startMs: T, endMs: T + 2 * 3_600_000 + 1 })).toMatchObject({ kind: "invalid" });
    expect(await bad({ cameraId: CAM, startMs: T, endMs: T + 50_000 })).toMatchObject({ kind: "disk" });
  });

  test("runs one export at a time and the rest wait in order", async () => {
    seed();
    const exports = make();
    const a = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 20_000 });
    const b = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 20_000 });
    const c = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 20_000 });
    expect([a.ahead, b.ahead, c.ahead]).toEqual([0, 1, 2]);
    const seen = new Set<string>();
    const watch = setInterval(() => {
      const running = exports.list().filter((j) => j.state === "running").length;
      seen.add(String(running));
    }, 2);
    await finished(exports, c.id);
    clearInterval(watch);
    expect([...seen].every((n) => n === "0" || n === "1")).toBe(true);
    expect(exports.list().map((j) => j.state)).toEqual(["done", "done", "done"]);
    expect(exports.list().every((j) => j.progress === 1)).toBe(true);
  }, 40_000);

  test("an export that does not finish in time is killed together with its process group", async () => {
    seed();
    const stall = join(root, "stall-ffmpeg.sh");
    writeFileSync(stall, "#!/bin/sh\nsleep 60 &\nsleep 60\n");
    chmodSync(stall, 0o755);
    const exports = make({ env: { ffmpegBin: stall, ffprobeBin: "ffprobe" }, timeoutMs: 300 });
    const job = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 20_000 });
    await Bun.sleep(100);
    const pid = exports.activePid();
    expect(pid).not.toBeNull();
    const done = await finished(exports, job.id, 5_000);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("逾時");
    expect(exports.activePid()).toBeNull();
    const alive = (() => {
      try {
        process.kill(-pid!, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(alive).toBe(false);
  }, 15_000);

  test("memory kill fails the running job; cancel removes a queued one and stops a running one", async () => {
    seed();
    const stall = join(root, "stall2-ffmpeg.sh");
    writeFileSync(stall, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(stall, 0o755);
    const exports = make({ env: { ffmpegBin: stall, ffprobeBin: "ffprobe" } });
    const a = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 20_000 });
    const b = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 20_000 });
    await Bun.sleep(100);
    expect(exports.remove(b.id)).toBe(true);
    expect(exports.get(b.id)).toBeNull();
    exports.killForMemory();
    const done = await finished(exports, a.id, 5_000);
    expect(done.error).toContain("記憶體");

    const c = await exports.create({ cameraId: CAM, startMs: T, endMs: T + 20_000 });
    await Bun.sleep(100);
    const pid = exports.activePid()!;
    exports.remove(c.id);
    await Bun.sleep(400);
    expect(exports.activePid()).toBeNull();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  test("startup wipes leftovers; finished exports and their files expire after 24 hours", async () => {
    seed();
    const dir = join(root, `exp-wipe${++seq}`);
    mkdirSync(join(dir, "stale"), { recursive: true });
    writeFileSync(join(dir, "stale", "export.mp4"), "old");
    const exports = make({ dir, pidFile: join(root, "pid-wipe.json") }, undefined);
    await exports.ready;
    expect(readdirSync(dir)).toEqual([]);

    const clock = { now: T + 3_600_000 };
    const timed = make({ now: () => clock.now, ttlMs: 24 * 3_600_000 });
    const job = await timed.create({ cameraId: CAM, startMs: T, endMs: T + 10_000 });
    const done = await finished(timed, job.id);
    expect(done.expiresAt).toBe(done.finishedAt! + 24 * 3_600_000);
    const path = timed.file(job.id)!.path;
    clock.now += 23 * 3_600_000;
    await timed.sweep();
    expect(existsSync(path)).toBe(true);
    clock.now += 2 * 3_600_000;
    await timed.sweep();
    expect(existsSync(path)).toBe(false);
    expect(timed.get(job.id)).toBeNull();
  }, 30_000);
});

describe("export API", () => {
  const user: Principal = { userId: 2, username: "viewer", role: "user", via: "session" };

  function api(authed = true) {
    seed();
    const exports = make();
    const handle = createRouter(exportRoutes(exports), { authenticate: () => (authed ? user : null) });
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handle(
        new Request(`http://x${path}`, {
          method,
          headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    return { exports, call };
  }

  test("a regular user creates an export, polls it, and downloads a file ffprobe accepts", async () => {
    const { exports, call } = api();
    const created = await call("POST", "/api/exports", { cameraId: CAM, startMs: T + 2_000, endMs: T + 14_000, tz: "Asia/Taipei" });
    expect(created.status).toBe(201);
    const job = (await created.json()) as ExportDto;
    expect(job.state === "queued" || job.state === "running").toBe(true);
    expect((await call("GET", "/api/exports/" + job.id + "/file")).status).toBe(409);
    await finished(exports, job.id);

    const polled = (await (await call("GET", `/api/exports/${job.id}`)).json()) as ExportDto;
    expect(polled.state).toBe("done");
    expect(((await (await call("GET", "/api/exports")).json()) as ExportDto[]).map((j) => j.id)).toEqual([job.id]);

    const res = await call("GET", `/api/exports/${job.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("客廳_20261119-160002.mp4")}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(polled.sizeBytes!);
    const downloaded = join(root, "downloaded.mp4");
    await Bun.write(downloaded, bytes);
    const p = await probe(downloaded);
    expect(p.audio?.codec).toBe("aac");
    expect(Math.abs(p.durationS - 12)).toBeLessThan(1.6);

    const ranged = await call("GET", `/api/exports/${job.id}/file`, undefined, { range: "bytes=0-99" });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    expect((await call("DELETE", `/api/exports/${job.id}`)).status).toBe(204);
    expect((await call("GET", `/api/exports/${job.id}`)).status).toBe(404);
  }, 30_000);

  test("reports clear errors for bad input, an empty range, and a missing login", async () => {
    const { call } = api();
    const err = async (res: Response) => ((await res.json()) as { error: string }).error;
    let res = await call("POST", "/api/exports", { cameraId: CAM, startMs: T + 20_000, endMs: T + 30_000 });
    expect([res.status, await err(res)]).toEqual([422, "這段時間沒有錄影"]);
    res = await call("POST", "/api/exports", { cameraId: CAM, startMs: T, endMs: T + 3 * 3_600_000 });
    expect([res.status, await err(res)]).toEqual([400, "一次最多匯出 2 小時，請縮短選取的範圍"]);
    res = await call("POST", "/api/exports", { cameraId: "ghost", startMs: T, endMs: T + 5000 });
    expect(res.status).toBe(404);
    res = await call("POST", "/api/exports", { cameraId: CAM, startMs: "x", endMs: 1 });
    expect(res.status).toBe(400);
    res = await call("POST", "/api/exports", { cameraId: CAM, startMs: T, endMs: T + 5000, tz: "Mars/Base" });
    expect(res.status).toBe(400);
    expect((await call("GET", "/api/exports/doesnotexist")).status).toBe(404);
    const anon = api(false);
    expect((await anon.call("GET", "/api/exports")).status).toBe(401);
  });
});
