import { describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readEnv } from "../env.ts";
import { parseSegmentPath } from "./layout.ts";
import { camera, tempSettings, writeSegment } from "./test-helpers.ts";
import { BROKEN_TIMESTAMP_LINES, ensureDayDirs, recordWorkerSpec, type RecordTiming } from "./worker.ts";

const env = readEnv({ FFMPEG_BIN: "/usr/bin/ffmpeg" });

function flag(cmd: string[], name: string) {
  const i = cmd.indexOf(name);
  return i === -1 ? undefined : cmd[i + 1];
}

test("records over TCP into UTC-named fragmented MP4 minute segments", async () => {
  const settings = await tempSettings();
  const spec = recordWorkerSpec(camera("cam1"), settings, "rtsp://127.0.0.1:8554/cam1/main", env);
  expect(spec.id).toBe("record:cam1");
  expect(spec.kind).toBe("record");
  expect(spec.env).toEqual({ TZ: "UTC" });
  expect(spec.cmd[0]).toBe("/usr/bin/ffmpeg");
  expect(flag(spec.cmd, "-i")).toBe("rtsp://127.0.0.1:8554/cam1/main");
  expect(flag(spec.cmd, "-rtsp_transport")).toBe("tcp");
  expect(flag(spec.cmd, "-timeout")).toBe("10000000");
  expect(flag(spec.cmd, "-c:v")).toBe("copy");
  expect(flag(spec.cmd, "-segment_time")).toBe("60");
  expect(flag(spec.cmd, "-segment_atclocktime")).toBe("1");
  expect(flag(spec.cmd, "-segment_format_options")).toBe("movflags=frag_keyframe+empty_moov+default_base_moof:flush_packets=1");
  expect(spec.cmd.at(-1)).toBe(join(settings.storagePath, "cam1", "%Y%m%d", "%H%M%S.mp4"));
});

test("audio is optional AAC 64k when enabled and dropped when disabled", async () => {
  const settings = await tempSettings();
  const on = recordWorkerSpec(camera("c", { audio: true }), settings, "rtsp://x", env).cmd;
  expect(flag(on, "-c:a")).toBe("aac");
  expect(flag(on, "-b:a")).toBe("64k");
  expect(on).toContain("0:a:0?");
  const off = recordWorkerSpec(camera("c", { audio: false }), settings, "rtsp://x", env).cmd;
  expect(off).toContain("-an");
  expect(off).not.toContain("-c:a");
});

test("direct recording of a UDP camera keeps its transport", async () => {
  const settings = await tempSettings();
  const cam = camera("c", { direct: true });
  cam.config.connection = { type: "rtsp", mainUrl: "rtsp://cam/main", transport: "udp" };
  expect(flag(recordWorkerSpec(cam, settings, "rtsp://cam/main", env).cmd, "-rtsp_transport")).toBe("udp");
});

test("a camera whose timestamps go backwards switches to arrival time once", async () => {
  const settings = await tempSettings();
  let broken = 0;
  const timing: RecordTiming = { arrival: false, onBroken: () => broken++ };
  const spec = recordWorkerSpec(camera("c", { audio: true }), settings, "rtsp://x", env, Date.now, timing);
  expect(spec.cmd).not.toContain("-use_wallclock_as_timestamps");
  spec.onOutputLine!("[vost#0:0/copy @ 0x1] Non-monotonic DTS; previous: 4992646, current: 3247327; changing to 4992647.");
  for (let i = 1; i < BROKEN_TIMESTAMP_LINES; i++) spec.onOutputLine!("frame=  12 fps=0.0");
  expect(broken).toBe(0);
  for (let i = 0; i < BROKEN_TIMESTAMP_LINES * 3; i++) spec.onOutputLine!("[aost#0:1/aac @ 0x2] Non-monotonic DTS; previous: 479004, current: 250853");
  expect(broken).toBe(1);

  const arrival = recordWorkerSpec(camera("c", { audio: true }), settings, "rtsp://x", env, Date.now, { ...timing, arrival: true });
  expect(flag(arrival.cmd, "-use_wallclock_as_timestamps")).toBe("1");
  expect(arrival.cmd.indexOf("-use_wallclock_as_timestamps")).toBeLessThan(arrival.cmd.indexOf("-i"));
  expect(flag(arrival.cmd, "-af")).toBe("aresample=async=1");
  for (let i = 0; i < BROKEN_TIMESTAMP_LINES * 3; i++) arrival.onOutputLine!("Non-monotonic DTS");
  expect(broken).toBe(1);
  expect(recordWorkerSpec(camera("c", { audio: false }), settings, "rtsp://x", env, Date.now, { arrival: true }).cmd).not.toContain("-af");
});

test("stall check fails once the newest file stops growing for 30 s", async () => {
  const settings = await tempSettings();
  let now = Date.UTC(2026, 10, 18, 0, 0, 10);
  const spec = recordWorkerSpec(camera("cam1"), settings, "rtsp://x", env, () => now);
  expect(await spec.stall!.healthy()).toBe(false);

  await writeSegment(settings, "cam1", Date.UTC(2026, 10, 17, 23, 59, 0), 10, now - 5_000);
  expect(await spec.stall!.healthy()).toBe(true);

  now += 40_000;
  expect(await spec.stall!.healthy()).toBe(false);

  await writeSegment(settings, "cam1", Date.UTC(2026, 10, 18, 0, 0, 0), 10, now - 1_000);
  expect(await spec.stall!.healthy()).toBe(true);
});

test("day directories exist for today and tomorrow (UTC) for recording cameras only", async () => {
  const settings = await tempSettings();
  const cams = [camera("rec"), camera("off", { enabled: false }), camera("disabled", {}, false)];
  await ensureDayDirs(cams, settings, Date.UTC(2026, 11, 31, 23, 30));
  await ensureDayDirs(cams, settings, Date.UTC(2026, 11, 31, 23, 30));
  expect((await readdir(settings.storagePath)).sort()).toEqual(["rec"]);
  expect((await readdir(join(settings.storagePath, "rec"))).sort()).toEqual(["20261231", "20270101"]);
});

test("one camera whose directory cannot be created does not hold back the others", async () => {
  const settings = await tempSettings();
  await Bun.write(join(settings.storagePath, "bad"), "a file where the camera directory should be");
  const errors = await ensureDayDirs([camera("bad"), camera("good")], settings, Date.UTC(2026, 11, 31, 23, 30));
  expect(errors).toHaveLength(2);
  expect((await readdir(join(settings.storagePath, "good"))).sort()).toEqual(["20261231", "20270101"]);
});

const realEnv = readEnv({});
const hasTools = Boolean(Bun.which(realEnv.ffmpegBin) && Bun.which(realEnv.ffprobeBin) && Bun.which(realEnv.mediamtxBin));

describe.skipIf(!hasTools)("against a live RTSP camera (needs ffmpeg, ffprobe and MediaMTX)", () => {
  test("the first segment holds no footage from before the time its name gives", async () => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const fake = Bun.spawn(["bun", join(import.meta.dir, "../../scripts/fake-camera.ts"), "--port", String(port)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const settings = await tempSettings();
    try {
      const reader = fake.stdout.getReader();
      for (let out = ""; !out.includes("READY"); ) {
        const { done, value } = await reader.read();
        if (done) throw new Error("fake camera exited early");
        out += new TextDecoder().decode(value);
      }
      const cam = camera("cam1");
      await ensureDayDirs([cam], settings, Date.now());
      const spec = recordWorkerSpec(cam, settings, `rtsp://127.0.0.1:${port}/stream1`, realEnv);
      const recorder = Bun.spawn(spec.cmd, { env: { ...process.env, ...spec.env }, stderr: "ignore" });
      await Bun.sleep(8_000);
      recorder.kill("SIGINT");
      await recorder.exited;

      const dayDirs = await readdir(join(settings.storagePath, "cam1"));
      const files = (await Promise.all(dayDirs.map(async (d) => (await readdir(join(settings.storagePath, "cam1", d))).map((f) => join(settings.storagePath, "cam1", d, f)))))
        .flat()
        .sort();
      const first = files[0]!;
      const wallSec = ((await stat(first)).mtimeMs - parseSegmentPath(first)!.startMs) / 1000;
      const ffprobe = Bun.spawnSync([realEnv.ffprobeBin, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", first]);
      const mediaSec = Number(ffprobe.stdout.toString().trim());
      expect(mediaSec).toBeGreaterThan(2);
      // The name is truncated to whole seconds, so the wall span may exceed the media by up to ~1 s. The reverse
      // stays within a GOP (0.31 s seen on ffmpeg 6.1); footage from the analysis phase would add 2 to 3 s.
      expect(mediaSec).toBeLessThanOrEqual(wallSec + 1);
    } finally {
      fake.kill("SIGTERM");
      await fake.exited;
      await rm(settings.storagePath, { recursive: true, force: true });
    }
  }, 30_000);
});

/** 推一條每 6 秒倒退 5 秒的 RTP 串流（模擬 Wi-Fi 不穩的 Tapo），用錄影指令錄 14 秒；segment 縮成 4 秒 */
async function recordJumpingStream(timing: RecordTiming): Promise<{ wallSec: number; mediaSec: number; frames: number; squeezed: number }[]> {
  const settings = await tempSettings();
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port + (probe.port % 2);
  probe.stop(true);
  await mkdir(settings.storagePath, { recursive: true });
  const sdp = join(settings.storagePath, "in.sdp");
  const jump = "PTS-floor(PTS*TB/6)*5/TB";
  const pub = Bun.spawn(
    [realEnv.ffmpegBin, "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-re", "-f", "lavfi", "-i", "sine=r=8000",
      "-map", "0:v", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-g", "15", "-bsf:v", `setts=pts=${jump}:dts=${jump}`, "-f", "rtp", `rtp://127.0.0.1:${port}`,
      "-map", "1:a", "-c:a", "pcm_alaw", "-bsf:a", `setts=pts=${jump}:dts=${jump}`, "-f", "rtp", `rtp://127.0.0.1:${port + 2}`, "-sdp_file", sdp],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    while (!(await Bun.file(sdp).exists())) await Bun.sleep(50);
    const cam = camera("cam1", { audio: true });
    await ensureDayDirs([cam], settings, Date.now());
    const spec = recordWorkerSpec(cam, settings, sdp, realEnv, Date.now, timing);
    const cmd = [...spec.cmd];
    cmd[cmd.indexOf("-segment_time") + 1] = "4";
    for (const name of ["-rtsp_transport", "-timeout"]) cmd.splice(cmd.indexOf(name), 2);
    cmd.splice(cmd.indexOf("-i"), 0, "-protocol_whitelist", "file,udp,rtp");
    const recorder = Bun.spawn(cmd, { env: { ...process.env, ...spec.env }, stdout: "ignore", stderr: "pipe" });
    const lines = (async () => {
      for (const line of (await new Response(recorder.stderr).text()).split("\n")) spec.onOutputLine?.(line);
    })();
    await Bun.sleep(14_000);
    recorder.kill("SIGINT");
    await recorder.exited;
    await lines;

    const dir = join(settings.storagePath, "cam1");
    const files = (await Promise.all((await readdir(dir)).map(async (d) => (await readdir(join(dir, d))).map((f) => join(dir, d, f))))).flat().sort();
    // 第一段含連線前的時間、最後一段被中斷，只看中間的
    return files.slice(1, -1).map((f, i) => {
      const pts = Bun.spawnSync([realEnv.ffprobeBin, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", f]).stdout.toString().trim().split("\n").map(Number);
      return {
        wallSec: (parseSegmentPath(files[i + 2]!)!.startMs - parseSegmentPath(f)!.startMs) / 1000,
        mediaSec: pts.at(-1)! - pts[0]!,
        frames: pts.length,
        squeezed: pts.slice(1).filter((t, j) => t - pts[j]! < 0.005).length,
      };
    });
  } finally {
    pub.kill();
    await pub.exited;
    await rm(settings.storagePath, { recursive: true, force: true });
  }
}

describe.skipIf(!hasTools)("a stream whose timestamps jump backwards (needs ffmpeg and ffprobe)", () => {
  test("stream timestamps squeeze the footage and report the camera broken", async () => {
    let broken = 0;
    const segments = await recordJumpingStream({ arrival: false, onBroken: () => broken++ });
    expect(broken).toBe(1);
    expect(segments.reduce((n, s) => n + s.squeezed, 0)).toBeGreaterThan(segments.reduce((n, s) => n + s.frames, 0) / 4);
  }, 30_000);

  test("arrival time keeps every segment as long as the wall time its name gives", async () => {
    const segments = await recordJumpingStream({ arrival: true });
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const s of segments) {
      // 忙碌的機器上偶爾兩個封包同時送達、時間幾乎相同；壞掉時是成批的四分之一以上
      expect(s.squeezed).toBeLessThan(s.frames / 20);
      // 檔名只到秒，前後各可能差將近 1 秒
      expect(Math.abs(s.mediaSec - s.wallSec)).toBeLessThan(1.5);
    }
  }, 30_000);
});
