import { expect, test } from "bun:test";
import { MotionTracker, SETTLE_MS } from "./motion.ts";

function setup(idleStopMs = 1500) {
  let t = 10_000;
  const tracker = new MotionTracker(() => t, idleStopMs);
  return { tracker, advance: (ms: number) => void (t += ms) };
}

test("沒動過的鏡頭不是忙碌中", () => {
  expect(setup().tracker.isBusy("a")).toBe(false);
});

test("持續移動中一直是忙碌，每次移動都延長", () => {
  const { tracker, advance } = setup();
  tracker.continuousMove("a");
  advance(1400);
  expect(tracker.isBusy("a")).toBe(true);
  tracker.continuousMove("a");
  advance(1400);
  expect(tracker.isBusy("a")).toBe(true);
});

test("手動停止後再忙碌 3 秒，之後恢復", () => {
  const { tracker, advance } = setup();
  tracker.continuousMove("a");
  advance(200);
  tracker.settle("a");
  advance(SETTLE_MS - 1);
  expect(tracker.isBusy("a")).toBe(true);
  advance(1);
  expect(tracker.isBusy("a")).toBe(false);
});

test("沒有收到停止時，最晚在安全停止送出後 3 秒恢復", () => {
  const { tracker, advance } = setup(1500);
  tracker.continuousMove("a");
  advance(1500 + SETTLE_MS - 1);
  expect(tracker.isBusy("a")).toBe(true);
  advance(1);
  expect(tracker.isBusy("a")).toBe(false);
});

test("各鏡頭獨立，forget 後立即恢復", () => {
  const { tracker } = setup();
  tracker.settle("a");
  expect(tracker.isBusy("b")).toBe(false);
  tracker.forget("a");
  expect(tracker.isBusy("a")).toBe(false);
});
