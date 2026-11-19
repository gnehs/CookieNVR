import { expect, test } from "bun:test";
import { FRAME_BYTES, FRAME_H, FRAME_W, MotionDetector, rasterizeMasks, WARMUP_FRAMES, type DiffParams } from "./motion.ts";

const params: DiffParams = { threshold: 25, minArea: 0.005 };

/** 有些紋理的靜止背景：水平漸層加格紋 */
function background(): Uint8Array {
  const f = new Uint8Array(FRAME_BYTES);
  for (let y = 0; y < FRAME_H; y++) for (let x = 0; x < FRAME_W; x++) f[y * FRAME_W + x] = 60 + (x >> 2) + ((x >> 4) + (y >> 4)) % 2 * 20;
  return f;
}

function withSquare(base: Uint8Array, x0: number, y0: number, size: number, value = 240): Uint8Array {
  const f = base.slice();
  for (let y = y0; y < Math.min(FRAME_H, y0 + size); y++) for (let x = x0; x < Math.min(FRAME_W, x0 + size); x++) f[y * FRAME_W + x] = value;
  return f;
}

let seed = 1;
function noisy(base: Uint8Array, amplitude: number): Uint8Array {
  const f = base.slice();
  for (let i = 0; i < f.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    f[i] = Math.max(0, Math.min(255, f[i]! + ((seed % (2 * amplitude + 1)) - amplitude)));
  }
  return f;
}

function warmedUp(masks = [] as Parameters<MotionDetector["setMasks"]>[0]) {
  const d = new MotionDetector();
  d.setMasks(masks);
  const bg = background();
  for (let i = 0; i < WARMUP_FRAMES; i++) expect(d.process(bg, params).state).toBe("warmup");
  return { d, bg };
}

test("the first frames after start are not judged", () => {
  const d = new MotionDetector();
  const bg = background();
  const verdicts = Array.from({ length: WARMUP_FRAMES }, (_, i) => d.process(i === 5 ? withSquare(bg, 100, 60, 40) : bg, params));
  expect(verdicts.every((v) => v.state === "warmup" && v.score === null && !v.motion)).toBe(true);
  expect(d.process(bg, params).state).toBe("ok");
});

test("a still scene scores zero", () => {
  const { d, bg } = warmedUp();
  for (let i = 0; i < 20; i++) expect(d.process(bg, params)).toEqual({ state: "ok", score: 0, motion: false });
});

test("a small moving object is motion", () => {
  const { d, bg } = warmedUp();
  // 24×24 的物體約占 9 個區塊，約 1% 畫面
  const v = d.process(withSquare(bg, 120, 80, 24), params);
  expect(v.state).toBe("ok");
  expect(v.motion).toBe(true);
  expect(v.score!).toBeGreaterThan(0.005);
  expect(v.score!).toBeLessThan(0.05);
  // 物體一路移動，每張都算動作
  for (let x = 130; x < 200; x += 10) expect(d.process(withSquare(bg, x, 80, 24), params).motion).toBe(true);
});

test("an object below the minimum area is ignored", () => {
  const { d, bg } = warmedUp();
  expect(d.process(withSquare(bg, 120, 80, 8), params).motion).toBe(false);
});

test("a sudden global brightness change resets the background instead of triggering", () => {
  const { d, bg } = warmedUp();
  const bright = bg.map((v) => Math.min(255, v + 80));
  expect(d.process(bright, params)).toEqual({ state: "light", score: null, motion: false });
  // 新背景已被採用：同樣亮度的下一張是靜止
  expect(d.process(bright, params)).toEqual({ state: "ok", score: 0, motion: false });
});

test("motion inside a mask does not count", () => {
  const mask = { points: [[0.3, 0.3], [0.7, 0.3], [0.7, 0.8], [0.3, 0.8]] as [number, number][] };
  const { d, bg } = warmedUp([mask]);
  expect(d.process(withSquare(bg, 120, 70, 40), params)).toMatchObject({ score: 0, motion: false });
  // 遮罩外的同樣物體照常觸發
  expect(d.process(withSquare(bg, 10, 10, 30), params).motion).toBe(true);
});

test("sensor noise does not trigger", () => {
  const { d, bg } = warmedUp();
  for (let i = 0; i < 30; i++) {
    const v = d.process(noisy(bg, 12), params);
    expect(v.motion).toBe(false);
  }
});

test("a parked object is absorbed into the background", () => {
  const { d, bg } = warmedUp();
  const parked = withSquare(bg, 120, 80, 30);
  expect(d.process(parked, params).motion).toBe(true);
  let frames = 1;
  while (d.process(parked, params).motion) frames++;
  // α = 0.05：差值每張乘 0.95，160 的落差約 36 張（7 秒）降到門檻 25 以下
  expect(frames).toBeGreaterThan(25);
  expect(frames).toBeLessThan(40);
});

test("reset starts over with a fresh warmup", () => {
  const { d, bg } = warmedUp();
  d.reset();
  expect(d.process(withSquare(bg, 0, 0, 200), params).state).toBe("warmup");
});

test("masks rasterize by pixel centre with even-odd fill", () => {
  const m = rasterizeMasks([{ points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] }], 10, 4);
  expect([...m.slice(0, 10)]).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  const tri = rasterizeMasks([{ points: [[0, 0], [1, 0], [0, 1]] }], 4, 4);
  expect(tri.reduce((a, b) => a + b, 0)).toBe(6);
});
