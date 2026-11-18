import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv } from "../env.ts";
import type { Camera, CameraId } from "../types.ts";
import { createRestream } from "./restream.ts";

setDefaultTimeout(60_000);

const env = { ...readEnv({}), rtspPort: 28591 };
const FAKE_PORT = 28590;
const AUTH_PORT = 28592;
const API_PORT = 29591;
const PASS = "p@ss#w&rd";
const hasTools = Boolean(Bun.which(env.ffmpegBin) && Bun.which(env.ffprobeBin) && Bun.which(env.mediamtxBin));

const fakeUrl = (path: string) => `rtsp://tapo:${encodeURIComponent(PASS)}@127.0.0.1:${FAKE_PORT}${path}`;

function camera(id: string, patch: { enabled?: boolean; withSub?: boolean } = {}): Camera {
  return {
    id: id as CameraId,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    config: {
      name: id,
      enabled: patch.enabled ?? true,
      record: { enabled: true, audio: true, direct: false },
      connection: {
        type: "rtsp",
        transport: "tcp",
        mainUrl: fakeUrl("/stream1"),
        ...(patch.withSub === false ? {} : { subUrl: fakeUrl("/stream2") }),
      },
    },
  };
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`逾時等待：${what}`);
}

async function probeWidth(url: string): Promise<number | null> {
  const proc = Bun.spawn(
    [env.ffprobeBin, "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", "-i", url],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  return out === "" ? null : Number(out);
}

async function rtspStatus(url: string): Promise<"ok" | "unauthorized" | "other"> {
  const proc = Bun.spawn([env.ffprobeBin, "-v", "error", "-rtsp_transport", "tcp", "-i", url], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code === 0) return "ok";
  return /401/.test(err) ? "unauthorized" : "other";
}

describe.skipIf(!hasTools)("restream（需要真的 MediaMTX、ffmpeg 與假相機）", () => {
  const configDir = mkdtempSync(join(tmpdir(), "restream-test-"));
  const accounts: Record<string, string> = { alice: "pw" };
  let externalEnabled = true;
  const restream = createRestream({
    env,
    configDir,
    authUrl: `http://127.0.0.1:${AUTH_PORT}/internal/rtsp-auth`,
    apiPort: API_PORT,
  });
  const route = restream.rtspAuthRoute({
    verify: async (u, s) => accounts[u] === s,
    externalEnabled: () => externalEnabled,
  });
  const authServer = Bun.serve({
    port: AUTH_PORT,
    hostname: "127.0.0.1",
    fetch: (req) => route.handler({ req, url: new URL(req.url), params: {}, principal: null, ip: "127.0.0.1" }),
  });

  let fake: Bun.Subprocess<"ignore", "pipe", "inherit">;
  let mediamtx: Bun.Subprocess | null = null;
  const startMediamtx = () => {
    mediamtx = Bun.spawn(restream.workerSpec().cmd, { stdout: "ignore", stderr: "ignore" });
  };
  const stopMediamtx = async () => {
    mediamtx?.kill("SIGKILL");
    await mediamtx?.exited;
    mediamtx = null;
  };

  const ext = (id: string, stream: "main" | "sub", creds = "alice:pw") =>
    restream.externalUrl("127.0.0.1", id as CameraId, stream).replace("rtsp://", `rtsp://${creds}@`);
  const ready = (id: string, stream: "main" | "sub") => restream.isReady(id as CameraId, stream);

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
    await stopMediamtx();
    fake.kill("SIGTERM");
    await fake.exited;
    await authServer.stop(true);
    rmSync(configDir, { recursive: true, force: true });
  });

  test("workerSpec 的 cmd 指向 mediamtx 與設定檔，並帶有 Control API 的卡死判定", async () => {
    const spec = restream.workerSpec();
    expect(spec.id).toBe("restream");
    expect(spec.kind).toBe("restream");
    expect(spec.cmd[0]).toBe(env.mediamtxBin);
    expect(spec.stall?.healthy).toBeFunction();
    expect(await spec.stall?.healthy()).toBe(false);
  });

  test("MediaMTX 還沒起來時 sync 會重試，起來後套用兩台攝影機的 path", async () => {
    const cams = [camera("cam1"), camera("cam2", { withSub: false })];
    const synced = restream.sync(cams);
    await Bun.sleep(1_000);
    startMediamtx();
    await synced;

    await waitFor(async () => (await ready("cam1", "main")) && (await ready("cam1", "sub")) && (await ready("cam2", "main")), "path 上線");
    expect(await ready("cam2", "sub")).toBe(false);
    expect(await restream.workerSpec().stall?.healthy()).toBe(true);
  });

  test("再次取得 workerSpec 不會改寫設定檔，所以不會讓 MediaMTX 熱重載而丟掉 path", async () => {
    restream.workerSpec();
    await Bun.sleep(1_500);
    expect(await ready("cam1", "main")).toBe(true);
  });

  test("用 internalUrl 讀得到對應解析度的影像", async () => {
    expect(await probeWidth(restream.internalUrl("cam1" as CameraId, "main"))).toBe(1920);
    expect(await probeWidth(restream.internalUrl("cam1" as CameraId, "sub"))).toBe(640);
  });

  test("externalUrl 不含帳密，內部網址則有", () => {
    expect(restream.externalUrl("nvr.local", "cam1" as CameraId, "main")).toBe("rtsp://nvr.local:28591/cam1/main");
    expect(restream.internalUrl("cam1" as CameraId, "main")).toMatch(/^rtsp:\/\/nvr-[0-9a-f]+:[0-9a-f]+@127\.0\.0\.1:28591\/cam1\/main$/);
  });

  test("驗證：對的帳密放行，錯的帳密與沒帳密都拒絕", async () => {
    expect(await rtspStatus(ext("cam1", "sub"))).toBe("ok");
    expect(await rtspStatus(ext("cam1", "sub", "alice:wrong"))).toBe("unauthorized");
    expect(await rtspStatus(ext("cam1", "sub").replace("alice:pw@", ""))).toBe("unauthorized");
  });

  test("驗證：不能推流，連帳密正確也一樣", async () => {
    const push = Bun.spawn(
      [env.ffmpegBin, "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=5", "-t", "2", "-c:v", "libx264", "-f", "rtsp", "-rtsp_transport", "tcp", ext("cam1", "main")],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await push.exited).not.toBe(0);
    expect(await probeWidth(restream.internalUrl("cam1" as CameraId, "main"))).toBe(1920);
  });

  test("驗證：關閉對外 RTSP 後外部被拒，內部 worker 照常", async () => {
    externalEnabled = false;
    try {
      expect(await rtspStatus(ext("cam1", "sub"))).not.toBe("ok");
      expect(await probeWidth(restream.internalUrl("cam1" as CameraId, "sub"))).toBe(640);
    } finally {
      externalEnabled = true;
    }
  });

  test("重複 sync 同一份清單不會重連來源", async () => {
    const readyTime = async () =>
      ((await (await fetch(`http://127.0.0.1:${API_PORT}/v3/paths/get/cam1/main`)).json()) as { readyTime: string }).readyTime;
    const before = await readyTime();
    await restream.sync([camera("cam1"), camera("cam2", { withSub: false })]);
    await restream.sync([camera("cam1"), camera("cam2", { withSub: false })]);
    expect(await readyTime()).toBe(before);
  });

  test("停用或刪除的攝影機會移除 path，只剩下仍啟用的", async () => {
    await restream.sync([camera("cam1", { enabled: false })]);
    expect(await ready("cam1", "main")).toBe(false);
    expect(await ready("cam2", "main")).toBe(false);

    await restream.sync([camera("cam1"), camera("cam2")]);
    await waitFor(async () => (await ready("cam2", "sub")) && (await ready("cam1", "main")), "重新上線");

    await restream.sync([camera("cam1")]);
    expect(await ready("cam2", "main")).toBe(false);
    expect(await ready("cam2", "sub")).toBe(false);
    expect(await ready("cam1", "main")).toBe(true);
  });

  test("MediaMTX 被殺掉重啟後，keepSynced 會把 path 補回來", async () => {
    const stop = restream.keepSynced(() => [camera("cam1"), camera("cam3", { withSub: false })], 300);
    try {
      await stopMediamtx();
      expect(await ready("cam1", "main")).toBe(false);
      startMediamtx();
      await waitFor(async () => (await ready("cam1", "main")) && (await ready("cam3", "main")), "重啟後 path 補回");
      expect(await ready("cam2", "main")).toBe(false);
      expect(await probeWidth(restream.internalUrl("cam3" as CameraId, "main"))).toBe(1920);
    } finally {
      stop();
    }
  });
});
