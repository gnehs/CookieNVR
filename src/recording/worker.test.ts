import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readEnv } from "../env.ts";
import { camera, tempSettings, writeSegment } from "./test-helpers.ts";
import { ensureDayDirs, recordWorkerSpec } from "./worker.ts";

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
