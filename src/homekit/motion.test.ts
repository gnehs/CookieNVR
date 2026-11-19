import { expect, test } from "bun:test";
import type { CameraId } from "../types";
import { motionByCamera } from "./motion";

const id = (s: string) => s as CameraId;

test("a camera detects motion while it has an event in progress", () => {
  const m = motionByCamera([
    { cameraId: id("a"), endMs: null },
    { cameraId: id("b"), endMs: 123 },
  ]);
  expect(m.get("a")).toBe(true);
  expect(m.get("b")).toBeUndefined();
  expect(m.get("c")).toBeUndefined();
});
