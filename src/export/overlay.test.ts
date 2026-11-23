import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBoxDto } from "../api-types.ts";
import { openDb } from "../db.ts";
import type { BoxSample } from "../events/store.ts";
import type { CameraId } from "../types.ts";
import { createExports } from "./manager.ts";
import { BOX_HOLD_MS, MAX_OVERLAY_BOXES, overlayBoxes, overlayFilter } from "./overlay.ts";
import type { PlanPart } from "./plan.ts";
import { addSegment, probe } from "./test-helpers.ts";

const T = Date.UTC(2026, 10, 19, 8, 0, 0);
const person = (x = 0.1): EventBoxDto => ({ label: "person", score: 0.9, box: [x, 0.2, x + 0.2, 0.8] });
const part = (startS: number, coveredS: number): PlanPart => ({
  segmentId: 1,
  startMs: T + startS * 1000,
  open: false,
  inpointMs: 0,
  outpointMs: null,
  coveredMs: coveredS * 1000,
  bytes: 0,
});
const at = (s: number, boxes: EventBoxDto[]): BoxSample => ({ atMs: T + s * 1000, boxes });
const times = (boxes: { fromS: number; toS: number }[]) => boxes.map((b) => [b.fromS, b.toS]);

describe("overlayBoxes", () => {
  test("a detection maps through the parts: earlier parts' length plus the offset inside its own, and a gap is skipped", () => {
    // Recorded [3, 10) and [40, 45): output 0-7 s, then 7-12 s.
    const parts = [part(3, 7), part(40, 5)];
    const boxes = overlayBoxes([at(5, [person()]), at(41, [person(0.5)]), at(20, [person(0.3)])], parts);
    expect(times(boxes)).toEqual([
      [2, 4],
      [8, 10],
    ]);
  });

  test("a box shows until the next sample and is held at most BOX_HOLD_MS; one held across a gap continues in the next part", () => {
    const parts = [part(0, 10), part(20, 10)];
    const boxes = overlayBoxes([at(1, [person(0.1)]), at(1.5, [person(0.5)]), at(9, [person(0.1)])], parts);
    expect(times(boxes)).toEqual([
      [1, 1.5],
      [1.5, 1.5 + BOX_HOLD_MS / 1000],
      [9, 10],
    ]);
  });

  test("consecutive samples of a box that stays put become one interval; one that moved or changed label starts a new one", () => {
    const car: EventBoxDto = { label: "car", score: 0.7, box: [0.11, 0.2, 0.31, 0.8] };
    const boxes = overlayBoxes([at(0, [person()]), at(0.2, [person(0.11)]), at(0.4, [person(0.11), car]), at(0.6, [person(0.4)])], [part(0, 10)]);
    expect(boxes.map((b) => [b.label, b.fromS, b.toS])).toEqual([
      ["person", 0, 0.6],
      ["car", 0.4, 0.6],
      ["person", 0.6, 2.6],
    ]);
  });

  test("a long event is thinned so the graph stays under the filter cap", () => {
    // Ten minutes at 5 fps, the box moving every sample.
    const samples = Array.from({ length: 3_000 }, (_, i) => at(i / 5, [person((i % 50) / 100)]));
    const boxes = overlayBoxes(samples, [part(0, 600)]);
    expect(boxes.length).toBeLessThanOrEqual(MAX_OVERLAY_BOXES);
    expect(boxes.length).toBeGreaterThan(MAX_OVERLAY_BOXES / 2);
    expect(boxes.at(-1)!.toS).toBeGreaterThan(590);
  });

  test("the filter graph trims the keyframe lead-in, scales, draws each box for its interval and starts at zero", () => {
    const graph = overlayFilter(overlayBoxes([at(1, [person()])], [part(0, 10)]));
    expect(graph.split(",\n")).toEqual([
      "trim=start=0",
      "scale=w=-2:h='min(720,trunc(ih/2)*2)'",
      "drawbox=x=iw*0.1000:y=ih*0.2000:w=iw*0.2000:h=ih*0.6000:color=0xFF3B30:t=3:enable='between(t,1.000,3.000)'",
      "format=yuv420p",
      "setpts=PTS-STARTPTS",
    ]);
  });
});

describe("a boxed clip", () => {
  const root = mkdtempSync(join(tmpdir(), "cookienvr-overlay-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const W = 320;
  const H = 240;
  /** The white square's left edge at wall-clock second s: one 12 px step per second. */
  const squareX = (s: number) => 10 + 12 * (Math.floor(s) % 25);

  /** A 10 s recording of second `fromS` onward, with a keyframe every 2 s so inpoints fall mid-GOP. */
  async function recordSegment(path: string, fromS: number): Promise<void> {
    mkdirSync(join(path, ".."), { recursive: true });
    const proc = Bun.spawn(
      [
        "ffmpeg",
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", `color=black:size=${W}x${H}:rate=25`, "-f", "lavfi", "-i", "color=white:size=20x20:rate=25"],
        ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
        ...["-filter_complex", `[0][1]overlay=x='10+12*mod(floor(t+${fromS}),25)':y=100[v]`, "-map", "[v]", "-map", "2:a"],
        ...["-t", "10", "-c:v", "libx264", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac"],
        ...["-movflags", "frag_keyframe+empty_moov+default_base_moof", path],
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(err);
  }

  /** Per frame of row y=110: where the white square starts and where a red box edge starts (-1 = none). */
  async function scan(path: string): Promise<{ t: number; white: number; red: number }[]> {
    const proc = Bun.spawn(["ffmpeg", "-v", "error", "-i", path, "-vf", "crop=320:2:0:110,format=rgb24", "-f", "rawvideo", "pipe:1"], { stdout: "pipe" });
    const buf = await new Response(proc.stdout).bytes();
    const row = W * 3 * 2;
    const out: { t: number; white: number; red: number }[] = [];
    for (let f = 0; (f + 1) * row <= buf.length; f++) {
      const px = buf.subarray(f * row, f * row + W * 3);
      let white = -1;
      let red = -1;
      for (let x = 0; x < W; x++) {
        const [r, g, b] = [px[x * 3]!, px[x * 3 + 1]!, px[x * 3 + 2]!];
        if (white < 0 && r > 200 && g > 200 && b > 200) white = x;
        if (red < 0 && r > 150 && g < 90 && b < 90) red = x;
      }
      out.push({ t: f / 25, white, red });
    }
    return out;
  }

  test("is re-encoded with audio, and each box lands on the frames it was detected in, across a mid-GOP inpoint and a gap", async () => {
    const db = openDb(":memory:");
    const cam = "cam1" as CameraId;
    for (const [name, fromS] of [["a", 0], ["b", 10], ["c", 40]] as const) {
      const file = join(root, `${name}.mp4`);
      await recordSegment(file, fromS);
      addSegment(db, cam, file, join(root, "rec", `${name}.mp4`), T + fromS * 1000, T + (fromS + 10) * 1000, statSync(file).size);
    }
    // A box 4 px larger than the square on each side, twice a second, as the detector would report it.
    const samples: BoxSample[] = [];
    for (let s = 3.5; s < 45; s += 0.5) {
      const x = squareX(s);
      samples.push({ atMs: T + s * 1000, boxes: [{ label: "person", score: 0.9, box: [(x - 4) / W, 96 / H, (x + 24) / W, 124 / H] }] });
    }
    const exports = createExports({
      db,
      cameras: { get: () => ({ id: cam, config: { name: "門口" } }) as never },
      env: { ffmpegBin: "ffmpeg", ffprobeBin: "ffprobe" },
      dir: join(root, "exp"),
      pidFile: join(root, "pid.json"),
      freeBytes: async () => 10 ** 12,
      now: () => T + 3_600_000,
    });
    try {
      // Recorded [3.3, 10) + [10, 20) + [40, 45): 21.7 s, with a gap after 16.7 s of output.
      const job = await exports.create({ cameraId: cam, startMs: T + 3_300, endMs: T + 45_000 }, { boxes: samples });
      for (let i = 0; exports.get(job.id)!.state !== "done"; i++) {
        expect(exports.get(job.id)!.state).not.toBe("failed");
        if (i > 1500) throw new Error("export did not finish");
        await Bun.sleep(20);
      }
      const path = exports.file(job.id)!.path;
      const p = await probe(path);
      expect(p.video?.codec).toBe("h264");
      expect(p.audio?.codec).toBe("aac");
      expect(Math.abs(p.durationS - 21.7)).toBeLessThan(0.3);

      const frames = await scan(path);
      const boxed = frames.filter((f) => f.red >= 0);
      // Every frame after the first sample (0.2 s in) carries a box.
      expect(boxed.length).toBeGreaterThan(frames.length - 15);
      // The box sits around the square (within a pixel of encoder blur). A box timed off by Δ surrounds where the
      // square was for Δ after each of the 22 one-second steps; two frames (80 ms) each are allowed.
      const aligned = (f: { red: number; white: number }) => Math.abs(f.red + 4 - f.white) <= 1;
      expect(boxed.filter((f) => !aligned(f)).length).toBeLessThanOrEqual(2 * 22);
      for (const outS of [2, 10, 18, 20]) expect(aligned(frames.find((x) => Math.abs(x.t - outS) < 0.01)!)).toBe(true);
    } finally {
      await exports.shutdown();
    }
  }, 60_000);
});
