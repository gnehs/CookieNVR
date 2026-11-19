import { expect, test } from "bun:test";
import { buildDiagnostics, type DiagnosticsInput } from "./diagnostics.ts";
import { defaultSettings, type Camera, type CameraConfig, type CameraId } from "./types.ts";

const NOW = Date.UTC(2026, 10, 19, 12);
const SECRETS = [
  "tapo-user-x",
  "Tapo#Pass!9",
  "rtspAdmin",
  "p@ss:w0rd/éè",
  "onvif-login",
  "onvif-pass-77",
  "cnvr_abcdEFGH1234567890",
  "session-cookie-value",
];

function cam(id: string, config: CameraConfig): Camera {
  return { id: id as CameraId, position: 0, config, createdAt: NOW, updatedAt: NOW };
}

const tapo = cam("front", {
  name: "前門",
  enabled: true,
  connection: { type: "tapo", host: "10.0.0.6", username: "tapo-user-x", password: "Tapo#Pass!9" },
  record: { enabled: true, audio: true, direct: false },
});
const rtsp = cam("yard", {
  name: "後院",
  enabled: true,
  connection: {
    type: "rtsp",
    mainUrl: `rtsp://rtspAdmin:${encodeURIComponent("p@ss:w0rd/éè")}@10.0.0.5:554/main`,
    subUrl: `rtsp://rtspAdmin:${encodeURIComponent("p@ss:w0rd/éè")}@10.0.0.5:554/sub`,
    transport: "tcp",
    onvif: { host: "10.0.0.5", port: 2020, username: "onvif-login", password: "onvif-pass-77" },
  },
  record: { enabled: true, audio: false, direct: true },
});

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    now: NOW,
    version: "1.2.3",
    runtime: { bun: "1.3.0", platform: "linux", arch: "x64", uptimeMs: 3_600_000, timeZone: "Asia/Taipei" },
    settings: defaultSettings("/data"),
    cameras: [
      { camera: tapo, online: true, recording: true, probe: null },
      {
        camera: rtsp,
        online: false,
        recording: false,
        probe: {
          at: NOW - 60_000,
          result: { ok: true, main: { videoCodec: "h264", width: 2560, height: 1440, fps: 15, audioCodec: "aac" }, sub: null, snapshotJpegBase64: "AAAA", onvif: { state: "unconfigured" } },
        },
      },
    ],
    only: null,
    workers: [
      { id: "restream", kind: "restream", state: "running", unstable: false, pid: 10, startedAt: NOW - 1000, restarts: 0, lastRestart: null, stderrTail: [] },
      {
        id: "record:yard",
        kind: "record",
        state: "backoff",
        unstable: true,
        pid: null,
        startedAt: null,
        restarts: 14,
        lastRestart: { reason: "exit", at: NOW - 5000, exitCode: 8 },
        // ffmpeg 會把完整網址印進錯誤訊息，帳密也在裡面
        stderrTail: [
          `[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized rtsp://rtspAdmin:${encodeURIComponent("p@ss:w0rd/éè")}@10.0.0.5:554/main`,
          "auth with Tapo#Pass!9 rejected for tapo-user-x",
          "Authorization: Bearer cnvr_abcdEFGH1234567890",
          "onvif-login / onvif-pass-77 rejected",
        ],
      },
      { id: "record:front", kind: "record", state: "running", unstable: false, pid: 11, startedAt: NOW - 1000, restarts: 0, lastRestart: null, stderrTail: [] },
    ],
    restarts: [
      {
        at: NOW - 5000,
        id: "record:yard",
        kind: "record",
        reason: "exit",
        exitCode: 8,
        signal: null,
        backoffMs: 4000,
        stderrTail: [`Opening rtsp://rtspAdmin:p@ss@10.0.0.5/main failed`, "cookie cnvr_session=session-cookie-value"],
      },
    ],
    disk: { path: "/data/recordings", totalBytes: 2 * 1024 ** 4, freeBytes: 1024 ** 4 },
    dataDisk: { path: "/data", totalBytes: 2 * 1024 ** 4, freeBytes: 1024 ** 4, sameAsRecordings: true },
    usage: [{ cameraId: "front" as CameraId, bytes: 5 * 1024 ** 3, oldestMs: NOW - 86_400_000 }],
    elsewhere: [],
    ...overrides,
  };
}

test("報告裡找不到任何密碼、相機帳號、網址帳密或 API Token", () => {
  const text = buildDiagnostics(input());
  for (const s of [...SECRETS, encodeURIComponent("p@ss:w0rd/éè")]) {
    expect(text).not.toContain(s);
  }
  expect(text).not.toMatch(/rtsp:\/\/[^*\s]+@/);
  expect(text).toContain("rtsp://***@10.0.0.5:554/main");
});

test("報告開頭說明用途，並包含排錯需要的內容", () => {
  const text = buildDiagnostics(input());
  expect(text.startsWith("# CookieNVR 診斷資訊\n")).toBe(true);
  expect(text).toContain("可以直接貼給 AI");
  expect(text).toContain("CookieNVR 1.2.3");
  expect(text).toContain("Bun 1.3.0，linux x64");
  expect(text).toContain("### 後院（id: yard）");
  expect(text).toContain("離線");
  expect(text).toContain("H264 2560×1440 15 fps");
  expect(text).toContain("狀態：backoff，不穩定");
  expect(text).toContain("重啟次數：14");
  expect(text).toContain("401 Unauthorized");
  expect(text).toContain("連續錄影 7 天");
});

test("?camera= 只留那一台與共用的轉發程序", () => {
  const text = buildDiagnostics(input({ only: "yard" as CameraId }));
  expect(text).toContain("後院");
  expect(text).not.toContain("前門");
  expect(text).not.toContain("record:front");
  expect(text).toContain("### restream");
  expect(text).toContain("### record:yard");
});
