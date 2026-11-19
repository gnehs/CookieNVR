import { expect, test } from "bun:test";
import { initialState, MAX_EVENT_MS, step, type Effect, type Signal } from "./lifecycle.ts";

const COOLDOWN = 10_000;

function run(signals: Signal[]) {
  const state = initialState();
  const fx: Effect[] = [];
  for (const s of signals) fx.push(...step(state, s, COOLDOWN));
  return { state, fx };
}

const px = (at: number, score: number | null) => ({ type: "pixel", at, score, motion: score !== null && score > 0.005 }) as const;
const tick = (at: number) => ({ type: "tick", at }) as const;
const onvif = (at: number, kind: string, active: boolean, sync = false) => ({ type: "onvif", at, kind, active, sync }) as const;

test("one frame of motion is not an event; two in a row start one at the first", () => {
  expect(run([px(0, 0.02), px(200, 0), px(400, 0.02), tick(1000)]).fx).toEqual([]);
  expect(run([px(0, 0.02), px(200, 0.03)]).fx).toEqual([{ type: "start", at: 0, source: "pixel", score: 0.03, labels: [] }]);
});

test("frames that were not judged break the streak", () => {
  expect(run([px(0, 0.02), px(200, null), px(400, 0.02)]).fx).toEqual([]);
});

test("a new peak updates the score and asks for a new thumbnail", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.03), px(400, 0.02), px(600, 0.1)]);
  expect(fx.slice(1)).toEqual([{ type: "update", score: 0.1, source: "pixel", labels: [], thumb: true }]);
});

test("the event ends at its last motion once the cooldown passes", () => {
  const { fx, state } = run([px(0, 0.02), px(200, 0.02), px(3000, 0.02), px(3200, 0.02), tick(12_000), tick(13_200)]);
  expect(fx.at(-1)).toEqual({ type: "end", at: 3200 });
  expect(fx.filter((f) => f.type === "end")).toHaveLength(1);
  expect(state.event).toBeNull();
});

test("continuous motion is split every 10 minutes", () => {
  const signals: Signal[] = [];
  for (let t = 0; t <= MAX_EVENT_MS + 5_000; t += 1_000) signals.push(px(t, 0.02), px(t + 200, 0.02), tick(t + 500));
  const { fx } = run(signals);
  const kinds = fx.filter((f) => f.type !== "update").map((f) => [f.type, f.at]);
  expect(kinds).toEqual([
    ["start", 0],
    ["end", MAX_EVENT_MS + 500],
    ["start", MAX_EVENT_MS + 500],
  ]);
});

test("ONVIF true starts at once and stays open until false plus cooldown", () => {
  const { fx } = run([onvif(1000, "motion", true), tick(30_000), onvif(40_000, "motion", false), tick(45_000), tick(50_000)]);
  expect(fx).toEqual([
    { type: "start", at: 1000, source: "onvif", score: 0, labels: [] },
    { type: "end", at: 40_000 },
  ]);
});

test("the subscription's initial state is not a new event", () => {
  expect(run([onvif(0, "motion", true, true), tick(1000), tick(60_000)]).fx).toEqual([]);
});

test("motion and person from one movement merge into one event with a label", () => {
  const { fx } = run([onvif(0, "motion", true), onvif(50, "person", true), onvif(5000, "motion", false), onvif(5000, "person", false), tick(16_000)]);
  expect(fx).toEqual([
    { type: "start", at: 0, source: "onvif", score: 0, labels: [] },
    { type: "update", score: 0, source: "onvif", labels: ["person"], thumb: false },
    { type: "end", at: 5000 },
  ]);
});

test("pixel and ONVIF triggers in the same stretch become one event from both sources", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), onvif(500, "motion", true), onvif(2000, "motion", false), tick(13_000)]);
  expect(fx).toEqual([
    { type: "start", at: 0, source: "pixel", score: 0.02, labels: [] },
    { type: "update", score: 0.02, source: "both", labels: [], thumb: false },
    { type: "end", at: 2000 },
  ]);
});

test("a lost subscription no longer holds the event open", () => {
  const { fx } = run([onvif(0, "motion", true), { type: "onvif-lost", at: 3000 }, tick(14_000)]);
  expect(fx.at(-1)).toEqual({ type: "end", at: 3000 });
});

test("stop ends the event right away", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), { type: "stop", at: 1000 }]);
  expect(fx.at(-1)).toEqual({ type: "end", at: 200 });
});
