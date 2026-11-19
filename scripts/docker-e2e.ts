// 容器端到端驗證：建置映像、啟動 NVR 容器與假相機容器，經 HTTP API 走完整條流程。
// 用法：bun scripts/docker-e2e.ts
// 環境變數：E2E_IMAGE（預設 cookienvr:e2e）、E2E_SKIP_BUILD=1、E2E_WEB_PORT（38704）、E2E_RTSP_PORT（38504）、
//          E2E_TZ（Asia/Taipei）、E2E_KEEP=1（結束後保留容器、volume 與 network 供除錯）。
// 失敗時印出失敗的步驟與兩個容器的日誌尾巴，退出碼 1。結束時移除自己建立的容器、volume 與 network。
import { join } from "node:path";

const IMAGE = process.env.E2E_IMAGE ?? "cookienvr:e2e";
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 38704);
const RTSP_PORT = Number(process.env.E2E_RTSP_PORT ?? 38504);
const TZ = process.env.E2E_TZ ?? "Asia/Taipei";
const PREFIX = "cookienvr-e2e";
const NET = `${PREFIX}-net`;
const VOLUME = `${PREFIX}-data`;
const NVR = `${PREFIX}-nvr`;
const CAM = `${PREFIX}-cam`;
const CAM_ALIAS = "fakecam";
const CAM_PORT = 28504;
const REPO = join(import.meta.dir, "..");
const USER = "admin";
const PASS = "e2e-password-1";
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const SEGMENT_MS = 60_000;

class StepError extends Error {}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new StepError(msg);
}

interface Run {
  code: number;
  stdout: Uint8Array;
  text: string;
  stderr: string;
}

async function exec(cmd: string[], input?: Uint8Array): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    stdin: input ? new Blob([input as Uint8Array<ArrayBuffer>]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, text: new TextDecoder().decode(stdout), stderr };
}

async function docker(args: string[], input?: Uint8Array): Promise<Run> {
  const r = await exec(["docker", ...args], input);
  check(r.code === 0, `docker ${args.slice(0, 3).join(" ")} 失敗（${r.code}）：${r.stderr.trim() || r.text.trim()}`);
  return r;
}

/** 在 NVR 容器內執行 sh 指令並回傳 stdout。 */
async function sh(script: string): Promise<string> {
  return (await docker(["exec", NVR, "sh", "-c", script])).text.trim();
}

async function until<T>(what: string, timeoutMs: number, fn: () => Promise<T | false | null | undefined>, everyMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) throw new StepError(`等待逾時（${Math.round(timeoutMs / 1000)} 秒）：${what}${lastError ? `（${lastError}）` : ""}`);
    await Bun.sleep(everyMs);
  }
}

let cookie = "";

async function api(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (cookie) headers.cookie = cookie;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  return fetch(`${BASE}${path}`, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
}

async function apiJson<T>(path: string, init?: Parameters<typeof api>[1]): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new StepError(`${init?.method ?? "GET"} ${path} 回 ${res.status}：${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface SegmentDto {
  id: number;
  cameraId: string;
  startMs: number;
  endMs: number | null;
  size: number;
}
interface WorkerStatus {
  id: string;
  state: string;
  pid: number | null;
  restarts: number;
  startedAt: number | null;
  lastRestart: { reason: string } | null;
  stderrTail: string[];
}
interface CameraDto {
  id: string;
  config: { name: string };
  online: boolean;
  recording: boolean;
}

const segments = (id: string) => apiJson<SegmentDto[]>(`/api/cameras/${id}/recordings?start=0&end=${Date.now() + 86_400_000}`);
const workers = async () => (await apiJson<{ workers: WorkerStatus[] }>("/api/system")).workers;

/** 最簡 RTSP 客戶端：DESCRIBE 並回傳狀態碼與 SDP。只用來驗證對外轉發的埠與帳密。 */
async function rtspDescribe(url: string, auth?: { user: string; pass: string }): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const headers = [`DESCRIBE ${url} RTSP/1.0`, "CSeq: 1", "Accept: application/sdp"];
  if (auth) headers.push(`Authorization: Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`);
  const request = `${headers.join("\r\n")}\r\n\r\n`;
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new StepError(`RTSP DESCRIBE 逾時：${url}`)), 8_000);
    void Bun.connect({
      hostname: u.hostname,
      port: Number(u.port),
      socket: {
        open: (s) => void s.write(request),
        data(s, chunk) {
          buf += new TextDecoder().decode(chunk);
          const split = buf.indexOf("\r\n\r\n");
          if (split < 0) return;
          const head = buf.slice(0, split);
          const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
          const body = buf.slice(split + 4);
          if (body.length < len) return;
          clearTimeout(timer);
          s.end();
          resolve({ status: Number(/^RTSP\/1\.0 (\d+)/.exec(head)?.[1] ?? 0), body });
        },
        error(_s, e) {
          clearTimeout(timer);
          reject(new StepError(`RTSP 連線失敗：${e.message}`));
        },
      },
    }).catch((e: Error) => {
      clearTimeout(timer);
      reject(new StepError(`RTSP 連線失敗：${e.message}`));
    });
  });
}

const rtspUrl = (id: string, stream: "main" | "sub" = "main") => `rtsp://127.0.0.1:${RTSP_PORT}/${id}/${stream}`;

async function removeResources(): Promise<void> {
  for (const c of [NVR, CAM]) await exec(["docker", "rm", "-f", "-v", c]);
  await exec(["docker", "volume", "rm", "-f", VOLUME]);
  await exec(["docker", "network", "rm", NET]);
}

async function startNvr(): Promise<void> {
  await docker([
    "run", "-d", "--name", NVR, "--network", NET,
    "-p", `${WEB_PORT}:8765`, "-p", `${RTSP_PORT}:8554`,
    "-v", `${VOLUME}:/data`,
    "-e", `TZ=${TZ}`,
    IMAGE,
  ]);
}

async function nvrLogs(tail = 80): Promise<string> {
  const r = await exec(["docker", "logs", "--tail", String(tail), NVR]);
  return r.text + r.stderr;
}

/** 容器內符合 cmdline 樣式的 pid。樣式用 [x] 寫法，避免比到這支 sh 自己。 */
async function pidsMatching(pattern: string): Promise<number[]> {
  const out = await sh(`for d in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $d/cmdline 2>/dev/null); case "$c" in ${pattern}) echo \${d#/proc/};; esac; done`);
  return out.split("\n").filter(Boolean).map(Number).sort((a, b) => a - b);
}

const recordFfmpegPids = () => pidsMatching("*ffmpeg*[-]segment_time*");
const mediamtxPids = () => pidsMatching("[m]ediamtx*");

interface Ctx {
  cameras: { id: string; name: string; direct: boolean }[];
}

type Step = [name: string, fn: (ctx: Ctx) => Promise<void>];

const steps: Step[] = [
  [
    "建置映像",
    async () => {
      if (process.env.E2E_SKIP_BUILD === "1") return log("略過建置（E2E_SKIP_BUILD=1）");
      const r = await exec(["docker", "build", "-t", IMAGE, REPO]);
      check(r.code === 0, `docker build 失敗：${(r.stderr || r.text).slice(-800)}`);
    },
  ],
  [
    "清掉上次殘留並建立網路",
    async () => {
      await removeResources();
      await docker(["network", "create", NET]);
      await docker(["volume", "create", VOLUME]);
    },
  ],
  [
    "啟動假相機容器",
    async () => {
      await docker([
        "create", "--name", CAM, "--no-healthcheck", "--network", NET, "--network-alias", CAM_ALIAS,
        "--entrypoint", "bun", IMAGE, "/app/fake-camera.ts", "--port", String(CAM_PORT),
      ]);
      await docker(["cp", join(REPO, "scripts", "fake-camera.ts"), `${CAM}:/app/fake-camera.ts`]);
      await docker(["start", CAM]);
      await until("假相機印出 READY", 60_000, async () => (await exec(["docker", "logs", CAM])).text.includes("READY"));
    },
  ],
  [
    "啟動 NVR 容器並等健康檢查變 healthy",
    async () => {
      await startNvr();
      await until("HTTP /api/info", 60_000, async () => (await fetch(`${BASE}/api/info`)).ok);
      await until("HEALTHCHECK 轉為 healthy", 120_000, async () => {
        const s = (await docker(["inspect", "-f", "{{.State.Health.Status}}", NVR])).text.trim();
        check(s !== "unhealthy", "健康檢查變成 unhealthy");
        return s === "healthy";
      }, 2000);
    },
  ],
  [
    "容器內工具版本",
    async () => {
      log((await sh("ffmpeg -version | head -1")));
      log((await sh("mediamtx --version")));
      log(`TZ=${await sh("echo $TZ")}，容器內本地時間 ${await sh("date")}`);
    },
  ],
  [
    "初始設定與登入",
    async () => {
      const info = await apiJson<{ needsSetup: boolean }>("/api/info");
      check(info.needsSetup, "全新 volume 應該需要初始設定");
      const res = await api("/api/auth/setup", { json: { username: USER, password: PASS } });
      if (!res.ok) throw new StepError(`setup 回 ${res.status}：${await res.text()}`);
      const setCookie = res.headers.get("set-cookie") ?? "";
      cookie = setCookie.split(";")[0] ?? "";
      check(cookie.includes("="), "setup 沒有回傳 session cookie");
      const me = await api("/api/me");
      check(me.ok, `帶 cookie 的 /api/me 回 ${me.status}`);
      check(!(await apiJson<{ needsSetup: boolean }>("/api/info")).needsSetup, "設定完成後 needsSetup 應為 false");
      // 預設保留 5 GiB 空間；測試主機空間不足時保留機制會刪光剛錄好的片段，讓結果取決於主機磁碟。
      await apiJson("/api/settings", { method: "PUT", json: { retention: { minFreeBytes: 0 } } });
    },
  ],
  [
    "測試連線（成功與失敗）",
    async () => {
      const good = await apiJson<{ ok: boolean; main?: { videoCodec: string; width: number }; sub?: unknown; snapshotJpegBase64?: string | null; error?: string }>(
        "/api/cameras/test",
        { json: { type: "rtsp", mainUrl: `rtsp://${CAM_ALIAS}:${CAM_PORT}/stream1`, subUrl: `rtsp://${CAM_ALIAS}:${CAM_PORT}/stream2`, transport: "tcp" } },
      );
      check(good.ok, `測試連線應成功：${good.error}`);
      check(good.main?.videoCodec === "h264" && good.main.width === 1920, `主碼流資訊不對：${JSON.stringify(good.main)}`);
      check(good.sub, "應該有子碼流資訊");
      check(typeof good.snapshotJpegBase64 === "string" && good.snapshotJpegBase64.startsWith("/9j/"), "測試連線應附 JPEG 快照");
      const bad = await apiJson<{ ok: boolean; error?: string }>("/api/cameras/test", {
        json: { type: "rtsp", mainUrl: `rtsp://${CAM_ALIAS}:${CAM_PORT}/nope`, transport: "tcp" },
      });
      check(!bad.ok && !!bad.error, "不存在的路徑應回失敗與說明");
      log(`失敗訊息：${bad.error}`);
    },
  ],
  [
    "新增兩台攝影機（經轉發錄影與直連錄影）",
    async (ctx) => {
      for (const direct of [false, true]) {
        const name = direct ? "直連" : "經轉發";
        const cam = await apiJson<CameraDto>("/api/cameras", {
          json: {
            name,
            enabled: true,
            connection: { type: "rtsp", mainUrl: `rtsp://${CAM_ALIAS}:${CAM_PORT}/stream1`, subUrl: `rtsp://${CAM_ALIAS}:${CAM_PORT}/stream2`, transport: "tcp" },
            record: { enabled: true, audio: true, direct },
          },
        });
        ctx.cameras.push({ id: cam.id, name, direct });
      }
      await until("兩台都上線並錄影", 60_000, async () => {
        const list = await apiJson<CameraDto[]>("/api/cameras");
        return list.length === 2 && list.every((c) => c.online && c.recording);
      });
    },
  ],
  [
    "錄影 worker 與轉發 worker 都在跑",
    async (ctx) => {
      await until("restream 與錄影 worker 都是 running", 60_000, async () => {
        const ws = await workers();
        return ["restream", ...ctx.cameras.map((c) => `record:${c.id}`)].every((id) => {
          const w = ws.find((x) => x.id === id);
          return w?.state === "running" && w.pid;
        });
      });
    },
  ],
  [
    `等每台攝影機至少 3 個已完成的片段（約 ${Math.ceil((3 * SEGMENT_MS) / 60_000) + 1} 分鐘）`,
    async (ctx) => {
      await until("每台 3 個完成片段", 330_000, async () => {
        for (const c of ctx.cameras) {
          if ((await segments(c.id)).filter((s) => s.endMs !== null).length < 3) return false;
        }
        return true;
      }, 5000);
    },
  ],
  [
    "沒有多餘的重啟與警告",
    async (ctx) => {
      const ws = await workers();
      for (const w of ws.filter((x) => x.id === "restream" || x.id.startsWith("record:"))) {
        check(w.restarts === 0, `${w.id} 在正常錄影期間重啟了 ${w.restarts} 次，最後一次 ${JSON.stringify(w.lastRestart)}`);
        for (const line of w.stderrTail.filter((l) => !/ INF /.test(l))) log(`${w.id} stderr：${line.slice(0, 200)}`);
      }
      check(ws.length === 1 + ctx.cameras.length, `worker 數量不對：${ws.map((w) => w.id).join(",")}`);
    },
  ],
  [
    "片段清單、下載與 ffprobe（h264 + aac）",
    async (ctx) => {
      for (const c of ctx.cameras) {
        const list = await segments(c.id);
        const done = list.filter((s) => s.endMs !== null);
        // 第一個片段從啟動那刻錄到下一個整分鐘，不是完整的一分鐘，所以驗第二個。
        const seg = done[1];
        check(seg, `${c.name} 沒有第二個完成的片段`);
        const res = await api(`/api/segments/${seg.id}`);
        check(res.status === 200 && res.headers.get("content-type") === "video/mp4", `${c.name} 下載回 ${res.status} ${res.headers.get("content-type")}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        check(bytes.length > 50_000, `${c.name} 片段只有 ${bytes.length} bytes`);
        const probe = await docker(["exec", "-i", NVR, "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", "pipe:0"], bytes);
        const info = JSON.parse(probe.text) as { streams: { codec_name: string; codec_type: string }[]; format: { duration?: string } };
        const names = info.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
        check(names.join() === "audio:aac,video:h264", `${c.name} 串流組成不對：${names.join()}`);
        const packets = await docker(
          ["exec", "-i", NVR, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", "pipe:0"],
          bytes,
        );
        const rows = packets.text.trim().split("\n").map((l) => l.split(","));
        const last = Math.max(...rows.map((r) => Number(r[0])));
        check(rows[0]?.[1]?.startsWith("K"), `${c.name} 片段的第一個影像封包不是關鍵影格，播放無法從頭開始`);
        check(last > 55 && last < 62, `${c.name} 完整片段的長度應約 60 秒，實際 ${last.toFixed(1)} 秒`);
        log(`${c.name} 片段 ${seg.id}：${bytes.length} bytes，${names.join(" ")}，長度 ${last.toFixed(1)} 秒`);

        const part = await api(`/api/segments/${seg.id}`, { headers: { range: "bytes=0-99" } });
        check(part.status === 206 && (await part.arrayBuffer()).byteLength === 100, `${c.name} Range 請求應回 206 與 100 bytes`);
      }
    },
  ],
  [
    "片段檔名是 UTC（容器 TZ 不影響）",
    async (ctx) => {
      const c = ctx.cameras[0]!;
      const files = (await sh(`ls /data/recordings/${c.id}/*/*.mp4`)).split("\n").filter(Boolean);
      check(files.length >= 3, `磁碟上只有 ${files.length} 個檔案`);
      const nowSec = Number(await sh("date -u +%s"));
      for (const f of files) {
        const m = /\/(\d{4})(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.mp4$/.exec(f);
        check(m, `檔名格式不對：${f}`);
        const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
        const ageSec = nowSec - ms / 1000;
        check(ageSec >= -2 && ageSec < 3600, `${f} 的名稱時間與 UTC 現在差 ${Math.round(ageSec)} 秒，疑似用了本地時區（${TZ}）`);
      }
      const list = await segments(c.id);
      const first = list[0]!;
      const idx = new Date(first.startMs).toISOString().replace(/[-:]/g, "").replace(/^(\d{8})T(\d{6}).*/, "$1/$2.mp4");
      check(files.some((f) => f.endsWith(idx)), `索引的 startMs 與磁碟檔名對不上（${idx}）`);
    },
  ],
  [
    "快照端點回 JPEG",
    async (ctx) => {
      for (const c of ctx.cameras) {
        const jpeg = await until(`${c.name} 快照`, 30_000, async () => {
          const res = await api(`/api/cameras/${c.id}/snapshot.jpg`);
          return res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : false;
        });
        check(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.at(-2) === 0xff && jpeg.at(-1) === 0xd9, `${c.name} 快照不是完整 JPEG`);
        check(jpeg.length > 3000, `${c.name} 快照只有 ${jpeg.length} bytes`);
      }
    },
  ],
  [
    "RTSP 轉發：正確帳密可讀、錯誤帳密被拒",
    async (ctx) => {
      for (const c of ctx.cameras) {
        for (const stream of ["main", "sub"] as const) {
          const url = rtspUrl(c.id, stream);
          const ok = await until(`${c.name}/${stream} 轉發就緒`, 30_000, async () => {
            const r = await rtspDescribe(url, { user: USER, pass: PASS });
            return r.status === 200 ? r : false;
          });
          check(/m=video[^\r\n]*\r?\n/.test(ok.body) && /H264/i.test(ok.body), `${c.name}/${stream} 的 SDP 沒有 H264 影像`);
          const wrong = await rtspDescribe(url, { user: USER, pass: "wrong-password" });
          check(wrong.status === 401, `錯誤密碼應回 401，實際 ${wrong.status}`);
          const anon = await rtspDescribe(url);
          check(anon.status === 401, `沒有帳密應回 401，實際 ${anon.status}`);
        }
      }
    },
  ],
  [
    "強制結束錄影 ffmpeg，會被重啟並恢復錄影",
    async (ctx) => {
      const before = await recordFfmpegPids();
      check(before.length === 2, `應有 2 個錄影 ffmpeg，實際 ${before.join(",") || "無"}`);
      const counts = new Map<string, number>();
      for (const c of ctx.cameras) counts.set(c.id, (await segments(c.id)).length);
      const killedAt = Date.now();
      await sh(`kill -9 ${before.join(" ")}`);
      await until("新的錄影 ffmpeg 出現（pid 不同）", 60_000, async () => {
        const now = await recordFfmpegPids();
        return now.length === 2 && now.every((p) => !before.includes(p));
      });
      const ws = await workers();
      for (const c of ctx.cameras) {
        const w = ws.find((x) => x.id === `record:${c.id}`);
        check(w && w.restarts >= 1 && w.lastRestart?.reason === "exit", `${c.name} worker 的重啟紀錄不對：${JSON.stringify(w)}`);
      }
      await expectGrowingSegments(ctx, killedAt, counts);
    },
  ],
  [
    "強制結束 MediaMTX，會被重啟、轉發與錄影恢復",
    async (ctx) => {
      const before = await mediamtxPids();
      check(before.length === 1, `應有 1 個 mediamtx，實際 ${before.join(",") || "無"}`);
      const counts = new Map<string, number>();
      for (const c of ctx.cameras) counts.set(c.id, (await segments(c.id)).length);
      const killedAt = Date.now();
      await sh(`kill -9 ${before[0]}`);
      await until("新的 mediamtx 出現", 60_000, async () => {
        const now = await mediamtxPids();
        return now.length === 1 && now[0] !== before[0];
      });
      const w = (await workers()).find((x) => x.id === "restream");
      check(w && w.restarts >= 1, `restream worker 沒有重啟紀錄：${JSON.stringify(w)}`);
      for (const c of ctx.cameras) {
        await until(`${c.name} RTSP 轉發在 mediamtx 重啟後恢復`, 90_000, async () => {
          const r = await rtspDescribe(rtspUrl(c.id), { user: USER, pass: PASS });
          return r.status === 200;
        }, 2000);
      }
      await expectGrowingSegments(ctx, killedAt, counts);
    },
  ],
  [
    "docker stop 在 10 秒內乾淨結束",
    async () => {
      const t0 = Date.now();
      await docker(["stop", "-t", "10", NVR]);
      const sec = (Date.now() - t0) / 1000;
      const state = (await docker(["inspect", "-f", "{{.State.ExitCode}} {{.State.OOMKilled}}", NVR])).text.trim();
      log(`docker stop 花了 ${sec.toFixed(1)} 秒，ExitCode/OOMKilled = ${state}`);
      check(sec < 10, `docker stop 花了 ${sec.toFixed(1)} 秒，超過 10 秒`);
      check(state === "0 false", `退出狀態不是乾淨結束（ExitCode/OOMKilled = ${state}），可能被 SIGKILL`);
      const out = await nvrLogs(200);
      check(!/Traceback|Unhandled|panic|uncaught/i.test(out), `停止期間日誌有例外：\n${out.slice(-600)}`);
    },
  ],
  [
    "同一個 volume 以新容器重啟：資料還在並繼續錄影",
    async (ctx) => {
      await docker(["rm", NVR]);
      cookie = "";
      const beforeCounts = new Map<string, number>();
      await startNvr();
      await until("HTTP /api/info", 60_000, async () => (await fetch(`${BASE}/api/info`)).ok);
      check(!(await apiJson<{ needsSetup: boolean }>("/api/info")).needsSetup, "重啟後不該回到初始設定");
      const login = await api("/api/auth/login", { json: { username: USER, password: PASS } });
      check(login.ok, `重啟後原帳密登入失敗（${login.status}）`);
      cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const list = await apiJson<CameraDto[]>("/api/cameras");
      check(list.length === 2 && ctx.cameras.every((c) => list.some((x) => x.id === c.id)), `攝影機清單不對：${JSON.stringify(list.map((c) => c.id))}`);
      const restartedAt = Date.now();
      for (const c of ctx.cameras) {
        const segs = await segments(c.id);
        check(segs.filter((s) => s.endMs !== null).length >= 3, `${c.name} 重啟後片段索引少於 3 個（${segs.length}）`);
        beforeCounts.set(c.id, segs.length);
      }
      await until("兩台重新上線並錄影", 60_000, async () => {
        const l = await apiJson<CameraDto[]>("/api/cameras");
        return l.every((c) => c.online && c.recording);
      });
      await expectGrowingSegments(ctx, restartedAt, beforeCounts);
      const days = await apiJson<string[]>(`/api/cameras/${ctx.cameras[0]!.id}/days`);
      check(days.length >= 1, "days 清單是空的");
    },
  ],
  [
    "容器被 SIGKILL（斷電等級）後以新容器重啟：能恢復並繼續錄影",
    async (ctx) => {
      await docker(["kill", NVR]);
      await docker(["rm", NVR]);
      cookie = "";
      await startNvr();
      await until("HTTP /api/info", 60_000, async () => (await fetch(`${BASE}/api/info`)).ok);
      const login = await api("/api/auth/login", { json: { username: USER, password: PASS } });
      check(login.ok, `被殺掉後重啟，原帳密登入失敗（${login.status}）`);
      cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const startedAt = Date.now();
      const counts = new Map<string, number>();
      for (const c of ctx.cameras) counts.set(c.id, (await segments(c.id)).length);
      await expectGrowingSegments(ctx, startedAt, counts);
      for (const c of ctx.cameras) {
        const open = (await segments(c.id)).filter((s) => s.endMs === null);
        check(open.length <= 1, `${c.name} 有 ${open.length} 個沒有結尾的片段，被殺掉時中斷的那段沒有被收尾`);
      }
      const ws = await workers();
      check(ws.filter((w) => w.state === "running" || w.state === "starting").length === 1 + ctx.cameras.length, `worker 狀態不對：${JSON.stringify(ws.map((w) => [w.id, w.state]))}`);
    },
  ],
];

/** 重啟之後：多出至少一個開始時間晚於 since 的片段，而且它的檔案大小持續增加。 */
async function expectGrowingSegments(ctx: Ctx, since: number, counts: Map<string, number>): Promise<void> {
  for (const c of ctx.cameras) {
    const seg = await until(`${c.name} 在 ${new Date(since).toISOString().slice(11, 19)} 之後出現新片段`, 120_000, async () => {
      const list = await segments(c.id);
      const fresh = list.filter((s) => s.startMs >= since - 2000);
      return list.length > (counts.get(c.id) ?? 0) && fresh.length > 0 ? fresh.at(-1) : false;
    }, 2000);
    const sizeOf = async () => (await segments(c.id)).find((s) => s.id === seg.id)?.size ?? 0;
    const first = await sizeOf();
    await until(`${c.name} 的新片段持續變大`, 60_000, async () => (await sizeOf()) > first, 2000);
  }
}

async function main(): Promise<number> {
  const ctx: Ctx = { cameras: [] };
  let failed: { step: string; error: unknown } | null = null;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    log("收到中斷訊號，清理中");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const check0 = await exec(["docker", "version", "--format", "{{.Server.Version}}"]);
  if (check0.code !== 0) {
    console.error("無法連到 docker daemon（macOS 請先 colima start）：", check0.stderr.trim());
    return 1;
  }

  for (const [i, [name, fn]] of steps.entries()) {
    if (interrupted) break;
    log(`步驟 ${i + 1}/${steps.length}：${name}`);
    const t0 = Date.now();
    try {
      await fn(ctx);
    } catch (error) {
      failed = { step: `${i + 1}. ${name}`, error };
      break;
    }
    log(`  通過（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  }

  if (failed) {
    const message = failed.error instanceof Error ? failed.error.message : String(failed.error);
    console.error(`\n失敗的步驟：${failed.step}\n原因：${message}`);
    if (!(failed.error instanceof StepError) && failed.error instanceof Error) console.error(failed.error.stack);
    console.error(`\n--- ${NVR} 日誌尾巴 ---\n${await nvrLogs()}`);
    console.error(`--- ${CAM} 日誌尾巴 ---\n${(await exec(["docker", "logs", "--tail", "30", CAM])).text}`);
  }
  if (process.env.E2E_KEEP === "1") {
    console.error(`E2E_KEEP=1，保留容器 ${NVR}、${CAM}、volume ${VOLUME}、network ${NET}`);
  } else {
    await removeResources();
  }
  if (interrupted) return 130;
  if (failed) return 1;
  log("全部通過");
  return 0;
}

process.exit(await main());
