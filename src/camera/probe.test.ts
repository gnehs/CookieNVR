import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { readEnv } from "../env.ts";
import { explainFailure, probeCamera } from "./probe.ts";

setDefaultTimeout(30_000);

const env = readEnv({});
const FAKE_PORT = 28581;
const PASS = "p@ss#w&rd";
const hasTools = Boolean(Bun.which(env.ffmpegBin) && Bun.which(env.ffprobeBin) && Bun.which(env.mediamtxBin));

describe("explainFailure", () => {
  test("把常見的 ffmpeg 錯誤轉成可讀的繁體中文", () => {
    expect(explainFailure("Server returned 401 Unauthorized (authorization failed)", false, false)).toBe("帳號或密碼錯誤");
    expect(explainFailure("Server returned 401 Unauthorized", false, true)).toContain("相機帳戶");
    expect(explainFailure("Connection to tcp://x:554?timeout=0 failed: Connection refused", false, false)).toContain("連線被拒絕");
    expect(explainFailure("method DESCRIBE failed: 404 Not Found", false, false)).toContain("找不到這個串流");
    expect(explainFailure("Connection timed out", false, false)).toContain("逾時");
    expect(explainFailure("", true, false)).toContain("逾時");
  });

  test("埠號裡的數字不會被當成 HTTP 狀態碼", () => {
    expect(explainFailure("rtsp://h:4010/x: Invalid data found", false, false)).toBe(
      "無法讀取串流：rtsp://h:4010/x: Invalid data found",
    );
  });
});

describe.skipIf(!hasTools)("probeCamera（需要 ffmpeg 與 mediamtx）", () => {
  let fake: Bun.Subprocess<"ignore", "pipe", "inherit">;

  beforeAll(async () => {
    fake = Bun.spawn(
      ["bun", join(import.meta.dir, "../../scripts/fake-camera.ts"), "--port", String(FAKE_PORT), "--user", "tapo", "--pass", PASS],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = fake.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (!out.includes("READY")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("假相機提前結束");
      out += decoder.decode(value);
    }
  });

  afterAll(async () => {
    fake.kill("SIGTERM");
    await fake.exited;
  });

  const fakeUrl = (path: string, pass = PASS) =>
    `rtsp://tapo:${encodeURIComponent(pass)}@127.0.0.1:${FAKE_PORT}${path}`;

  test("讀到主、子碼流的編碼、解析度、幀率、音訊與一張 JPEG 快照", async () => {
    const result = await probeCamera(
      { type: "rtsp", transport: "tcp", mainUrl: fakeUrl("/stream1"), subUrl: fakeUrl("/stream2") },
      env,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.main).toEqual({ videoCodec: "h264", width: 1920, height: 1080, fps: 15, audioCodec: "pcm_alaw" });
    expect(result.sub).toMatchObject({ videoCodec: "h264", width: 640, height: 360, audioCodec: "pcm_alaw" });
    const jpeg = Buffer.from(result.snapshotJpegBase64 ?? "", "base64");
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
  });

  test("沒有子碼流時 sub 是 null", async () => {
    const result = await probeCamera({ type: "rtsp", transport: "tcp", mainUrl: fakeUrl("/stream1") }, env);
    expect(result.ok && result.sub).toBeNull();
  });

  test("密碼錯誤回報帳號或密碼錯誤", async () => {
    const result = await probeCamera({ type: "rtsp", transport: "tcp", mainUrl: fakeUrl("/stream1", "wrong") }, env);
    expect(result).toEqual({ ok: false, error: "主碼流：帳號或密碼錯誤" });
  });

  test("通用 RTSP 的子碼流失敗要回報，並標明是子碼流", async () => {
    const result = await probeCamera(
      { type: "rtsp", transport: "tcp", mainUrl: fakeUrl("/stream1"), subUrl: fakeUrl("/nope") },
      env,
    );
    expect(result).toEqual({ ok: false, error: "子碼流：找不到這個串流，請檢查網址路徑是否正確" });
  });

  test("不存在的位址在逾時前就回報連線被拒絕，且不洩漏密碼", async () => {
    const result = await probeCamera(
      { type: "rtsp", transport: "tcp", mainUrl: fakeUrl("/stream1").replace(String(FAKE_PORT), "28599") },
      env,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("連線被拒絕");
      expect(result.error).not.toContain(PASS);
    }
  });

  test("連不到的位址會在逾時後回報", async () => {
    const started = Date.now();
    const result = await probeCamera(
      { type: "rtsp", transport: "tcp", mainUrl: "rtsp://10.255.255.1:554/stream1" },
      env,
      { timeoutMs: 3_000 },
    );
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(6_000);
    if (!result.ok) expect(result.error).toMatch(/逾時|無法連到/);
  });

  test("找不到 ffprobe 時給出明確訊息", async () => {
    const result = await probeCamera(
      { type: "rtsp", transport: "tcp", mainUrl: fakeUrl("/stream1") },
      { ...env, ffprobeBin: "/nonexistent/ffprobe" },
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("找不到 ffprobe");
  });
});
