import { afterEach, expect, test } from "bun:test";
import { FakeOnvif } from "../onvif/fake-onvif.ts";
import type { Camera, CameraId } from "../types.ts";
import { createOnvifSources, type OnvifSignal } from "./onvif-source.ts";
import { DEFAULT_DETECT } from "./config.ts";

let fake: FakeOnvif | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

function camera(f: FakeOnvif, source: "pixel" | "onvif" | "both"): Camera {
  return {
    id: "cam1" as CameraId,
    position: 0,
    groupId: null,
    createdAt: 0,
    updatedAt: 0,
    config: {
      name: "前門",
      enabled: true,
      connection: { type: "rtsp", mainUrl: "rtsp://127.0.0.1/x", transport: "tcp", onvif: f.endpoint },
      record: { enabled: false, audio: false, direct: false },
      detect: { ...DEFAULT_DETECT, source },
    },
  };
}

async function waitFor(fn: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

test("subscribes for ONVIF sources only and turns notifications into signals", async () => {
  fake = await new FakeOnvif().start();
  const signals: OnvifSignal[] = [];
  const sources = createOnvifSources({ onSignal: (_, s) => signals.push(s) });
  sources.reconcile([camera(fake, "pixel")]);
  expect(sources.status("cam1" as CameraId)).toBeNull();

  sources.reconcile([camera(fake, "both")]);
  await waitFor(() => sources.status("cam1" as CameraId)?.status.state === "active");
  fake.push({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", data: { IsMotion: "true" }, operation: "Initialized" });
  fake.push({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", data: { IsMotion: "true" }, operation: "Changed" });
  fake.push({ topic: "tns1:RuleEngine/PeopleDetector/People", data: { IsPeople: "true" }, operation: "Changed" });
  fake.push({ topic: "tns1:RuleEngine/TamperDetector/Tamper", data: { IsTamper: "true" }, operation: "Changed" });
  fake.push({ topic: "tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent", data: { IsTPSmartEvent: "true" }, operation: "Changed" });
  await waitFor(() => signals.length >= 3);
  await Bun.sleep(100);
  expect(signals.map((s) => ("lost" in s ? "lost" : [s.kind, s.active, s.sync]))).toEqual([
    ["motion", true, true],
    ["motion", true, false],
    ["person", true, false],
  ]);
  expect(sources.status("cam1" as CameraId)!.lastEvent).toMatchObject({ kind: "unknown", topic: "RuleEngine/TPSmartEventDetector/TPSmartEvent" });

  // 改回只用畫面差分：訂閱取消，相機狀態不再可信
  sources.reconcile([camera(fake, "pixel")]);
  expect(signals.at(-1)).toMatchObject({ lost: true });
  await waitFor(() => fake!.activeSubscriptions() === 0);
  await sources.stop();
});

test("a camera without PullPoint events ends up unsupported", async () => {
  fake = await new FakeOnvif({ without: ["Events"] }).start();
  const sources = createOnvifSources({ onSignal: () => {} });
  sources.reconcile([camera(fake, "onvif")]);
  await waitFor(() => sources.status("cam1" as CameraId)?.status.state === "unsupported");
  await sources.stop();
});
