import { expect, test } from "bun:test";
import { FILTER_WINDOW_MS, initialState, MAX_EVENT_MS, step, wantsObjects, type Effect, type ObjectHit, type Signal } from "./lifecycle.ts";

const COOLDOWN = 10_000;

function run(signals: Signal[], filter: boolean | ((s: Signal) => boolean) = false) {
  const state = initialState();
  const fx: Effect[] = [];
  const window = (s: Signal) => ((typeof filter === "function" ? filter(s) : filter) ? FILTER_WINDOW_MS : null);
  for (const s of signals) fx.push(...step(state, s, { cooldownMs: COOLDOWN, filterWindowMs: window(s) }));
  return { state, fx };
}

const px = (at: number, score: number | null) => ({ type: "pixel", at, score, motion: score !== null && score > 0.005 }) as const;
const tick = (at: number) => ({ type: "tick", at }) as const;
const onvif = (at: number, kind: string, active: boolean, sync = false) => ({ type: "onvif", at, kind, active, sync }) as const;

test("one frame of motion is not an event; two in a row start one at the first", () => {
  expect(run([px(0, 0.02), px(200, 0), px(400, 0.02), tick(1000)]).fx).toEqual([]);
  expect(run([px(0, 0.02), px(200, 0.03)]).fx).toEqual([{ type: "start", at: 0, source: "pixel", score: 0.03, labels: [], thumb: "next" }]);
});

test("frames that were not judged break the streak", () => {
  expect(run([px(0, 0.02), px(200, null), px(400, 0.02)]).fx).toEqual([]);
});

test("a new peak updates the score and asks for a new thumbnail", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.03), px(400, 0.02), px(600, 0.1)]);
  expect(fx.slice(1)).toEqual([{ type: "update", score: 0.1, source: "pixel", labels: [], thumb: "next" }]);
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
    { type: "start", at: 1000, source: "onvif", score: 0, labels: [], thumb: "next" },
    { type: "end", at: 40_000 },
  ]);
});

test("the subscription's initial state is not a new event", () => {
  expect(run([onvif(0, "motion", true, true), tick(1000), tick(60_000)]).fx).toEqual([]);
});

test("motion and person from one movement merge into one event with a label", () => {
  const { fx } = run([onvif(0, "motion", true), onvif(50, "person", true), onvif(5000, "motion", false), onvif(5000, "person", false), tick(16_000)]);
  expect(fx).toEqual([
    { type: "start", at: 0, source: "onvif", score: 0, labels: [], thumb: "next" },
    { type: "update", score: 0, source: "onvif", labels: ["person"], thumb: "none" },
    { type: "end", at: 5000 },
  ]);
});

test("pixel and ONVIF triggers in the same stretch become one event from both sources", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), onvif(500, "motion", true), onvif(2000, "motion", false), tick(13_000)]);
  expect(fx).toEqual([
    { type: "start", at: 0, source: "pixel", score: 0.02, labels: [], thumb: "next" },
    { type: "update", score: 0.02, source: "both", labels: [], thumb: "none" },
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

const obj = (at: number, ...hits: ObjectHit[]) => ({ type: "objects", at, hits }) as const;
const person = (score: number): ObjectHit => ({ label: "person", score });
const car = (score: number): ObjectHit => ({ label: "car", score });
const moving = (from: number, to: number) => {
  const out: Signal[] = [];
  for (let t = from; t <= to; t += 200) out.push(px(t, 0.02));
  return out;
};

test("annotate: a label is written only after two results in a row, with that frame as thumbnail", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), obj(500, person(0.7)), obj(1000), obj(1500, person(0.6)), obj(2000, person(0.8))]);
  expect(fx.slice(1)).toEqual([{ type: "update", score: 0.02, source: "pixel", labels: ["person"], thumb: "frame" }]);
});

test("annotate: a more confident frame replaces the thumbnail; motion peaks no longer do", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), obj(500, person(0.6)), obj(1000, person(0.6)), obj(1500, person(0.9)), obj(2000, person(0.7)), px(2200, 0.5)]);
  expect(fx.slice(1).map((f) => f.type === "update" && [f.labels, f.thumb])).toEqual([
    [["person"], "frame"],
    [["person"], "frame"],
    [["person"], "none"],
  ]);
});

test("labels on alternating frames never confirm", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), obj(500, person(0.9)), obj(1000, car(0.9)), obj(1500, person(0.9)), obj(2000, car(0.9))]);
  expect(fx).toHaveLength(1);
});

test("a confirmation does not carry over to the next event", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), obj(500, person(0.9)), tick(11_000), px(20_000, 0.02), px(20_200, 0.02), obj(20_500, person(0.9))]);
  expect(fx.map((f) => f.type)).toEqual(["start", "end", "start"]);
});

test("filter: motion alone is not announced; a confirmed label starts the event at the first motion frame", () => {
  const { fx, state } = run([px(0, 0.02), px(200, 0.02), tick(500), obj(600, person(0.7)), tick(1000), obj(1100, person(0.9))], true);
  expect(fx).toEqual([{ type: "start", at: 0, source: "pixel", score: 0.02, labels: ["person"], thumb: "frame" }]);
  expect(state.event?.tag).toBe("active");
});

test("filter: nothing watched within 3 seconds discards the motion, and the next window gets its full 3 seconds", () => {
  const signals: Signal[] = [...moving(0, 3000), tick(FILTER_WINDOW_MS), ...moving(3200, 4400), obj(4500, person(0.9)), obj(5000, person(0.9))];
  const { fx } = run(signals, true);
  expect(fx).toEqual([{ type: "start", at: 3200, source: "pixel", score: 0.02, labels: ["person"], thumb: "frame" }]);
  expect(run([...moving(0, 2000), tick(FILTER_WINDOW_MS), tick(20_000)], true).fx).toEqual([]);
});

test("filter: if the detector goes away while waiting, the event starts anyway", () => {
  const { fx } = run([px(0, 0.02), px(200, 0.02), tick(500), tick(1000)], (s) => !(s.type === "tick" && s.at === 1000));
  expect(fx).toEqual([{ type: "start", at: 0, source: "pixel", score: 0.02, labels: [], thumb: "next" }]);
});

test("filter: stop while waiting announces nothing", () => {
  const { fx, state } = run([px(0, 0.02), px(200, 0.02), { type: "stop", at: 300 }], true);
  expect(fx).toEqual([]);
  expect(wantsObjects(state)).toBe(false);
});

test("frames are wanted while waiting or recording, not while idle", () => {
  const state = initialState();
  const policy = { cooldownMs: COOLDOWN, filterWindowMs: FILTER_WINDOW_MS };
  expect(wantsObjects(state)).toBe(false);
  step(state, px(0, 0.02), policy);
  step(state, px(200, 0.02), policy);
  expect(wantsObjects(state)).toBe(true);
});

test("filter: a longer window (slow recognition) keeps waiting past 3 seconds", () => {
  const state = initialState();
  const policy = { cooldownMs: COOLDOWN, filterWindowMs: 5_000 };
  const fx: Effect[] = [];
  for (const s of [...moving(0, 4000), tick(4000), obj(4100, person(0.9)), obj(4600, person(0.9))]) fx.push(...step(state, s, policy));
  expect(fx).toEqual([{ type: "start", at: 0, source: "pixel", score: 0.02, labels: ["person"], thumb: "frame" }]);
});
