// 開發用假後端：bun run web/dev-mock.ts，之後開 http://localhost:48765
// 開發用假後端的示範登入：啟動時就建好這兩個帳號，不會進到初始設定頁（MOCK_FRESH=1 時不建，用來測初始設定）
const DEMO_ADMIN = { username: "admin", password: "admin1234" };
const DEMO_USER = { username: "viewer", password: "viewer1234" };
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CameraDto, EventDto, ExportDto, OnvifProbeDto, ProbeResult, PtzDto, PtzPresetDto, SegmentDto, SystemDto, UserDto } from "../src/api-types.ts";
import type { CameraConfig, CameraId, Role, Settings, WorkerStatus } from "../src/types.ts";
import { buildDiagnostics } from "../src/diagnostics.ts";
import { explainFailure } from "../src/camera/probe.ts";
import { exportFileName } from "../src/export/filename.ts";
import { planExport } from "../src/export/plan.ts";
import { encodeFrame, FrameKind } from "../src/live/mux.ts";
import index from "./index.html";

const PORT = Number(process.env.PORT ?? 48765);
const cacheDir = join(tmpdir(), "cookienvr-web-mock");
mkdirSync(cacheDir, { recursive: true });
const snapFile = join(cacheDir, "snap.jpg");
// 三個 60 秒的 fMP4 輪流當作每分鐘的片段；色相不同，畫面上的計時器每段從 0 開始，方便看接縫
const segFiles = [0, 120, 240].map((hue, i) => {
  const file = join(cacheDir, `seg60-${i}.mp4`);
  if (!existsSync(file)) {
    Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=15,hue=h=${hue}`, "-f", "lavfi", "-i", `sine=frequency=${440 + i * 220}:sample_rate=48000`, "-t", "60", "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", file]);
  }
  return file;
});
const thumbFiles = ["testsrc2", "smptebars", "rgbtestsrc", "testsrc2,hue=h=200"].map((src, i) => {
  const file = join(cacheDir, `thumb-${i}.jpg`);
  if (!existsSync(file)) {
    Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", `${src.split(",")[0]}=size=320x180:rate=1${src.includes(",") ? `,${src.split(",")[1]}` : ""}`, "-frames:v", "1", file]);
  }
  return file;
});
if (!existsSync(snapFile)) {
  Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1", "-frames:v", "1", snapFile]);
}
const snapB64 = existsSync(snapFile) ? Buffer.from(await Bun.file(snapFile).arrayBuffer()).toString("base64") : null;

const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const now = () => Date.now();

interface MockUser { id: number; username: string; password: string; role: Role; createdAt: number; lastLoginAt: number | null }
const users: MockUser[] = [];
let nextUserId = 1;
const FRESH = process.env.MOCK_FRESH === "1";
if (!FRESH) {
  for (const [demo, role] of [[DEMO_ADMIN, "admin"], [DEMO_USER, "user"]] as const) {
    users.push({ id: nextUserId++, username: demo.username, password: hash(demo.password), role, createdAt: now(), lastLoginAt: null });
  }
}
const sessions = new Map<string, { userId: number; ua: string; ip: string; lastSeenAt: number }>();
const tokens: { id: number; userId: number; name: string; prefix: string; createdAt: number; lastUsedAt: number | null }[] = [];
let nextTokenId = 1;
const fails = new Map<string, number>();

let settings: Settings = {
  siteName: "CookieNVR",
  storagePath: "/data/recordings",
  retention: { continuousDays: 7, eventDays: 30, minFreeBytes: 5 * 1024 ** 3 },
  rtsp: { externalEnabled: true },
};

const cams: { id: CameraId; position: number; config: CameraConfig }[] = [];
let camSeq = 1;
function addCam(config: CameraConfig) {
  const id = `cam${camSeq++}` as CameraId;
  cams.push({ id, position: cams.length, config });
  return cams[cams.length - 1]!;
}
addCam({ name: "客廳", enabled: true, connection: { type: "tapo", host: "192.168.1.50", username: "nvr", password: "secret123" }, record: { enabled: true, audio: true, direct: false } });
addCam({ name: "車庫", enabled: true, connection: { type: "rtsp", mainUrl: "rtsp://u:p@192.168.1.60/s1", subUrl: "rtsp://u:p@192.168.1.60/s2", transport: "tcp" }, record: { enabled: true, audio: false, direct: true } });
addCam({ name: "前門", enabled: true, connection: { type: "tapo", host: "192.168.1.52", username: "nvr", password: "secret123" }, record: { enabled: true, audio: true, direct: false } });
addCam({ name: "後院（停用）", enabled: false, connection: { type: "rtsp", mainUrl: "rtsp://192.168.1.61/s1", transport: "udp" }, record: { enabled: false, audio: false, direct: false } });
addCam({ name: "車道", enabled: true, connection: { type: "tapo", host: "192.168.1.53", username: "nvr", password: "secret123" }, record: { enabled: true, audio: false, direct: false } });
// 每台攝影機佔用的錄影空間；攝影機刪掉後沒清除的錄影會留在這裡，成為「已刪除的攝影機」
const usage = new Map<string, { bytes: number; oldestMs: number }>(
  cams.slice(0, 2).map((c, i) => [c.id, { bytes: (180 - i * 90) * 1024 ** 3, oldestMs: now() - (6 - i * 3) * 86_400_000 }]),
);
// MOCK_XSS=1：多一台名稱是 HTML 的攝影機，用來確認所有頁面都把名稱當文字顯示；給使用者看的假後端不加
if (process.env.MOCK_XSS === "1") addCam({ name: `<img src=x onerror="window.__xss=1">車庫<script>window.__xss=1</script>`, enabled: true, connection: { type: "tapo", host: "192.168.1.70", username: "nvr", password: "secret123" }, record: { enabled: true, audio: true, direct: false } });

// ---------- 假錄影與事件：依「距今第幾天」與當天分鐘數決定有沒有錄影 ----------
const MIN = 60_000;
const DAY = 86_400_000;
const localMidnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const daysAgo = (ms: number) => Math.round((localMidnight(now()) - localMidnight(ms)) / DAY);
const hm = (h: number, m: number) => h * 60 + m;
/** [開始分鐘, 結束分鐘) 的錄影時段；今天的錄影一路錄到現在 */
const SCHEDULE: Record<string, [number, number][]> = {
  "0:0": [[0, hm(2, 10)], [hm(2, 40), hm(9, 5)], [hm(9, 8), hm(11, 31)], [hm(11, 32), hm(13, 0)], [hm(13, 20), 1440]],
  "0:1": [[0, hm(2, 10)], [hm(2, 40), hm(9, 5)], [hm(9, 8), hm(11, 31)], [hm(11, 32), hm(13, 0)], [hm(13, 20), 1440]],
  "0:2": [[hm(6, 0), hm(23, 0)]],
  "1:0": [[0, hm(5, 0)], [hm(7, 0), 1440]],
  "1:1": [[hm(8, 0), hm(20, 0)]],
  "1:2": [[hm(8, 0), hm(20, 0)]],
};
const SEG_ID_BASE = 1_000_000_000;

function recorded(camIdx: number, t: number): boolean {
  const ranges = SCHEDULE[`${camIdx}:${daysAgo(t)}`];
  if (!ranges) return false;
  const minute = Math.floor((t - localMidnight(t)) / MIN);
  return ranges.some(([a, b]) => minute >= a && minute < b);
}

function segmentsIn(cameraId: string, start: number, end: number): SegmentDto[] {
  const camIdx = cams.findIndex((c) => c.id === cameraId);
  if (camIdx < 0 || camIdx > 1) return [];
  const out: SegmentDto[] = [];
  const t0 = now();
  for (let m = Math.floor(start / MIN) - 1; m * MIN < end; m++) {
    const t = m * MIN;
    if (t > t0) break;
    if (t + MIN <= start || !recorded(camIdx, t)) continue;
    const live = t + MIN > t0;
    out.push({ id: camIdx * SEG_ID_BASE + m, cameraId: cameraId as CameraId, startMs: t, endMs: live ? null : t + MIN, size: 1_800_000 + (m % 7) * 90_000 });
  }
  return out;
}

function recordedDays(cameraId: string, tz: string): string[] {
  const camIdx = cams.findIndex((c) => c.id === cameraId);
  if (camIdx < 0 || camIdx > 1) return [];
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return [2, 1, 0].map((d) => fmt.format(localMidnight(now()) - d * DAY + 12 * 3600_000));
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABEL_SETS = [["person"], ["person"], ["car"], ["cat"], ["person", "car"], ["dog"], ["package", "person"], [], []];
const eventCache = new Map<string, EventDto[]>();

/** 某台攝影機某一天的假事件：零散分布的幾十筆，加上 18:00 起一段密集的 */
function dayEvents(camIdx: number, dayStart: number): EventDto[] {
  const key = `${camIdx}:${dayStart}`;
  const hit = eventCache.get(key);
  if (hit) return hit;
  const r = rng(dayStart / MIN + camIdx * 7919);
  const out: EventDto[] = [];
  const cameraId = cams[camIdx]!.id;
  const push = (start: number, length: number) => {
    if (!recorded(camIdx, start)) return;
    const labels = LABEL_SETS[Math.floor(r() * LABEL_SETS.length)]!;
    out.push({ id: 0, cameraId, source: r() < 0.8 ? "pixel" : "onvif", startMs: start, endMs: start + length, score: Math.round((0.05 + r() * 0.55) * 100) / 100, labels, hasThumb: r() < 0.9 });
  };
  const length = () => {
    const x = r();
    return Math.round(x < 0.6 ? 3_000 + r() * 27_000 : x < 0.9 ? 30_000 + r() * 90_000 : 120_000 + r() * 240_000);
  };
  const count = camIdx === 0 ? 42 : 12;
  for (let i = 0; i < count; i++) push(dayStart + Math.floor(r() * 1440) * MIN + Math.floor(r() * 60_000), length());
  if (camIdx === 0) {
    let t = dayStart + hm(18, 0) * MIN;
    for (let i = 0; i < 26; i++) {
      push(t, 3_000 + Math.round(r() * 17_000));
      t += 15_000 + Math.round(r() * 75_000);
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  out.forEach((e, i) => (e.id = camIdx * 1_000_000 + daysAgo(dayStart) * 1_000 + i + 1));
  eventCache.set(key, out);
  return out;
}

function eventsIn(cameraId: string | null, start: number, end: number, limit: number): EventDto[] {
  const t0 = now();
  const out: EventDto[] = [];
  cams.slice(0, 2).forEach((c, camIdx) => {
    if (cameraId && c.id !== cameraId) return;
    for (let d = localMidnight(start); d < end; d += DAY) {
      if (daysAgo(d) < 0 || daysAgo(d) > 2) continue;
      for (const e of dayEvents(camIdx, localMidnight(d + 3_600_000))) {
        if (e.endMs! > t0) continue;
        if (e.startMs < end && e.endMs! > start) out.push(e);
      }
    }
    // 一筆進行中的事件，45 秒前開始
    const live: EventDto = { id: camIdx * 1_000_000 + 999, cameraId: c.id, source: "pixel", startMs: Math.floor(t0 / 1000) * 1000 - 45_000, endMs: null, score: 0.42, labels: ["person"], hasThumb: true };
    if (camIdx === 0 && live.startMs < end && t0 > start) out.push(live);
  });
  return out.sort((a, b) => a.startMs - b.startMs || a.id - b.id).slice(0, limit);
}

const workers: WorkerStatus[] = [
  { id: "restream", kind: "restream", state: "running", unstable: false, pid: 4101, startedAt: now() - 3 * 3600_000, restarts: 0, lastRestart: null, stderrTail: [] },
  ...cams.slice(0, 2).map((c, i): WorkerStatus => ({ id: `record:${c.id}`, kind: "record", state: i ? "backoff" : "running", unstable: i === 1, pid: i ? null : 4200 + i, startedAt: now() - 600_000, restarts: i ? 14 : 2, lastRestart: { reason: i ? "exit" : "stall", at: now() - 120_000, exitCode: i ? 1 : null }, stderrTail: i ? ["[tcp @ 0x1] Connection timed out", "rtsp://u:***@192.168.1.60/s1: Operation timed out"] : [] })),
];

function userDto(u: MockUser): UserDto {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
}

function camDto(c: (typeof cams)[number], admin: boolean): CameraDto {
  const cfg: CameraConfig = admin ? c.config : JSON.parse(JSON.stringify(c.config).replace(/"password":"[^"]*"/g, '"password":""'));
  const idx = cams.indexOf(c);
  return {
    id: c.id,
    position: c.position,
    config: cfg,
    online: c.config.enabled && idx !== 1,
    recording: c.config.enabled && c.config.record.enabled && idx === 0,
    rtsp: { main: `rtsp://${"localhost"}:8554/${c.id}/main`, sub: `rtsp://localhost:8554/${c.id}/sub` },
  };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (status: number, error: string) => Response.json({ error }, { status });
const noContent = () => new Response(null, { status: 204 });

function cookieOf(req: Request, name: string) {
  return req.headers.get("cookie")?.split(/;\s*/).map((p) => p.split("=")).find(([k]) => k === name)?.[1];
}

function principal(req: Request): MockUser | null {
  const sid = cookieOf(req, "sid");
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) return null;
  s.lastSeenAt = now();
  return users.find((u) => u.id === s.userId) ?? null;
}

function startSession(req: Request, u: MockUser): string {
  const sid = crypto.randomUUID().replaceAll("-", "");
  sessions.set(sid, { userId: u.id, ua: req.headers.get("user-agent") ?? "", ip: "127.0.0.1", lastSeenAt: now() });
  u.lastLoginAt = now();
  return sid;
}

const withCookie = (res: Response, sid: string) => {
  res.headers.append("set-cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  return res;
};

/** 錄製中的片段只回應「已經錄到」的比例，模擬檔案持續變大 */
async function serveSegment(req: Request, id: number): Promise<Response> {
  const m = id % SEG_ID_BASE;
  const startMs = m * MIN;
  const file = Bun.file(segFiles[m % segFiles.length]!);
  const full = file.size;
  const elapsed = now() - startMs;
  const size = elapsed >= MIN ? full : Math.max(4096, Math.floor((full * elapsed) / MIN));
  const headers = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": elapsed >= MIN ? "private, max-age=86400" : "no-store" };
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (!range) return new Response(file.slice(0, size), { headers: { ...headers, "content-length": String(size) } });
  const start = range[1] ? Number(range[1]) : 0;
  if (start >= size) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
  });
}

// 匯出：依時間推進假的進度。同時只跑一個，每個大約 5 秒，其餘排隊
interface MockExport { dto: ExportDto; runMs: number }
const exportJobs: MockExport[] = [];
const EXPORT_RUN_MS = 5_000;

function exportView(job: MockExport): ExportDto {
  const t = now();
  let cursor = 0;
  let startAt = 0;
  let ahead = 0;
  for (const j of exportJobs) {
    const s = Math.max(cursor, j.dto.createdAt);
    cursor = s + j.runMs;
    if (j === job) {
      startAt = s;
      break;
    }
    if (t < cursor) ahead++;
  }
  const endAt = startAt + job.runMs;
  const d = job.dto;
  if (t >= endAt) return { ...d, state: "done", progress: 1, ahead: null, sizeBytes: d.estimatedBytes, finishedAt: endAt, expiresAt: endAt + 86_400_000 };
  if (t >= startAt) return { ...d, state: "running", progress: (t - startAt) / job.runMs, ahead: null };
  return { ...d, state: "queued", progress: 0, ahead };
}

async function exportApi(req: Request, url: URL, path: string, body: any): Promise<Response | null> {
  const m = req.method;
  if (path === "/exports" && m === "GET") return json(exportJobs.map(exportView).reverse());
  if (path === "/exports" && m === "POST") {
    const c = cams.find((x) => x.id === body.cameraId);
    if (!c) return err(404, "找不到攝影機");
    const plan = planExport(segmentsIn(c.id, Number(body.startMs) - MIN, Number(body.endMs) + MIN), Number(body.startMs), Number(body.endMs), now());
    if (!plan.ok) return err(plan.reason === "empty" ? 422 : 400, plan.message);
    const id = crypto.randomUUID().slice(0, 16);
    const dto: ExportDto = {
      id,
      cameraId: c.id,
      cameraName: c.config.name,
      startMs: plan.startMs,
      endMs: plan.endMs,
      durationMs: plan.durationMs,
      estimatedBytes: plan.estimatedBytes,
      includesRecording: plan.includesRecording,
      state: "queued",
      progress: 0,
      ahead: 0,
      sizeBytes: null,
      error: null,
      fileName: exportFileName(c.config.name, plan.startMs, String(body.tz ?? "UTC")),
      createdAt: now(),
      finishedAt: null,
      expiresAt: null,
    };
    exportJobs.push({ dto, runMs: EXPORT_RUN_MS });
    return json(exportView(exportJobs[exportJobs.length - 1]!), 201);
  }
  const mm = path.match(/^\/exports\/(\w+)(\/file)?$/);
  if (!mm) return null;
  const job = exportJobs.find((j) => j.dto.id === mm[1]);
  if (!job) return err(404, "找不到這個匯出，可能已經過期");
  if (mm[2] && m === "GET") {
    if (exportView(job).state !== "done") return err(409, "匯出還沒有完成");
    const name = job.dto.fileName;
    return new Response(Bun.file(segFiles[0]!), { headers: { "content-type": "video/mp4", "content-disposition": `attachment; filename="export.mp4"; filename*=UTF-8''${encodeURIComponent(name)}` } });
  }
  if (!mm[2] && m === "GET") return json(exportView(job));
  if (!mm[2] && m === "DELETE") {
    exportJobs.splice(exportJobs.indexOf(job), 1);
    return noContent();
  }
  return null;
}

// ---------- 假 PTZ：能力依攝影機而不同，方便做介面時看各種情況 ----------
// 客廳：持續＋相對＋變焦、預置點上限 8；前門：只有相對移動、沒有變焦、上限 3；
// 車道（Tapo 但相機沒有 PTZ）、車庫與停用的後院（通用 RTSP 沒填 ONVIF）：不支援。
interface MockPtz { continuous: boolean; relative: boolean; zoom: boolean; maxPresets: number; presets: PtzPresetDto[]; nextToken: number }
const ptzByName: Record<string, MockPtz> = {
  客廳: { continuous: true, relative: true, zoom: true, maxPresets: 8, presets: [{ token: "1", name: "大門" }, { token: "2", name: "沙發" }, { token: "3", name: "窗邊" }], nextToken: 4 },
  前門: { continuous: false, relative: true, zoom: false, maxPresets: 3, presets: [{ token: "1", name: "門口" }], nextToken: 2 },
};
function mockPtzOf(c: (typeof cams)[number]): { kind: "no-onvif" } | { kind: "no-ptz" } | { kind: "ok"; ptz: MockPtz } {
  if (c.config.connection.type === "rtsp" && !c.config.connection.onvif) return { kind: "no-onvif" };
  const ptz = ptzByName[c.config.name];
  return ptz ? { kind: "ok", ptz } : { kind: "no-ptz" };
}
function onvifProbeOf(conn: any): OnvifProbeDto {
  if (conn.type === "rtsp" && !conn.onvif) return { state: "unconfigured" };
  const host = String(conn.type === "tapo" ? conn.host : conn.onvif.host);
  if (host.includes("onvifdown")) return { state: "unavailable", kind: "unreachable", message: "連不上相機的控制連線，請確認相機已開機、與本機在同一個網路，且 ONVIF 位址與埠號正確" };
  if (host.includes("noptz")) return { state: "available", ptz: false, zoom: false, maxPresets: null };
  return { state: "available", ptz: true, zoom: true, maxPresets: 8 };
}
// 開發用開關：MOCK_PTZ_DOWN=1 啟動，或 POST /api/mock/ptz?down=1&fail=1&delay=300 即時切換。
// down：GET 能力回 503（連不上）；fail：move 回 502；delay：每個 PTZ 請求多等幾毫秒
const ptzFault = { down: process.env.MOCK_PTZ_DOWN === "1", fail: false, delay: 0 };
const ptzRoute = (path: string) => path.match(/^\/cameras\/([^/]+)\/ptz(\/presets)?$/);
async function ptzApi(req: Request, path: string, admin: boolean, parsed: any): Promise<Response | null> {
  if (path === "/mock/ptz" && req.method === "POST") {
    const q = new URL(req.url).searchParams;
    if (q.has("down")) ptzFault.down = q.get("down") === "1";
    if (q.has("fail")) ptzFault.fail = q.get("fail") === "1";
    if (q.has("delay")) ptzFault.delay = Number(q.get("delay")) || 0;
    return json(ptzFault);
  }
  const mm = ptzRoute(path);
  if (!mm) return null;
  const m = req.method;
  const c = cams.find((x) => x.id === mm[1]);
  if (!c) return err(404, "找不到攝影機");
  const found = mockPtzOf(c);
  if (ptzFault.delay) await Bun.sleep(ptzFault.delay);
  if (!mm[2]) {
    if (m === "GET") {
      if (ptzFault.down && found.kind === "ok") return err(503, "連不上相機的控制連線，請確認相機已開機，且與本機在同一個網路");
      if (found.kind !== "ok") return json({ supported: false, reason: found.kind } satisfies PtzDto);
      const { continuous, relative, zoom, maxPresets, presets } = found.ptz;
      return json({ supported: true, continuous, relative, zoom, maxPresets, presets, prefs: { mode: c.config.ptz?.mode ?? "auto", speed: c.config.ptz?.speed ?? 0.5 } } satisfies PtzDto);
    }
    if (m !== "POST") return null;
    const b: any = parsed ?? (await req.json().catch(() => ({})));
    if (found.kind === "no-onvif") return err(409, "這台相機沒有設定 ONVIF，無法控制鏡頭");
    if (found.kind === "no-ptz") return err(409, "這台相機沒有鏡頭控制功能");
    if (b.action === "stop") return noContent();
    if (ptzFault.fail && b.action === "move") return err(502, "相機拒絕了這個指令，請稍後再試");
    if (b.action === "preset") return found.ptz.presets.some((p) => p.token === b.token) ? noContent() : err(502, "相機拒絕了這個指令，請稍後再試");
    if (b.action !== "move") return err(400, "欄位 action 必須是 move 或 stop 或 preset");
    if (Number(b.zoom ?? 0) !== 0 && !found.ptz.zoom) return err(409, "這台相機沒有變焦功能");
    const mode = b.mode ?? c.config.ptz?.mode ?? "auto";
    if (mode === "continuous" && !found.ptz.continuous) return err(409, "這台相機不支援持續移動，請改用微調或自動模式");
    return json({ mode: mode === "auto" ? (found.ptz.continuous ? "continuous" : "relative") : mode });
  }
  if (!admin) return err(403, "需要管理員權限");
  if (found.kind !== "ok") return err(409, found.kind === "no-onvif" ? "這台相機沒有設定 ONVIF，無法控制鏡頭" : "這台相機沒有鏡頭控制功能");
  const ptz = found.ptz;
  const b: any = parsed ?? (await req.json().catch(() => ({})));
  if (m === "POST") {
    const name = String(b.name ?? "").trim();
    if (!name) return err(400, "欄位 name 不能為空");
    if (b.token !== undefined) {
      const p = ptz.presets.find((x) => x.token === b.token);
      if (!p) return err(404, "找不到這個預置點");
      p.name = name;
      return json({ token: p.token, presets: ptz.presets });
    }
    if (ptz.presets.length >= ptz.maxPresets) return err(409, `預置點已滿，這台相機最多 ${ptz.maxPresets} 個，請先刪除一個`);
    const token = String(ptz.nextToken++);
    ptz.presets.push({ token, name });
    return json({ token, presets: ptz.presets }, 201);
  }
  if (m === "DELETE") {
    const i = ptz.presets.findIndex((x) => x.token === b.token);
    if (i < 0) return err(404, "找不到這個預置點");
    ptz.presets.splice(i, 1);
    return json({ presets: ptz.presets });
  }
  return null;
}

// SSE：連上先送完整狀態，攝影機有增刪改就推完整清單（假後端沒有即時狀態變化）
const streamClients = new Set<{ admin: boolean; send: (text: string) => void }>();
function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function broadcastCameras() {
  for (const c of streamClients) c.send(sse("cameras", cams.map((x) => camDto(x, c.admin))));
}
function streamResponse(admin: boolean): Response {
  const enc = new TextEncoder();
  let client: { admin: boolean; send: (text: string) => void };
  let ping: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      client = { admin, send: (text) => ctl.enqueue(enc.encode(text)) };
      streamClients.add(client);
      client.send(`retry: 3000\n\n${sse("snapshot", { cameras: cams.map((c) => camDto(c, admin)), workers: admin ? workers : null, events: [] })}`);
      ping = setInterval(() => client.send(": ping\n\n"), 20_000);
    },
    cancel() {
      clearInterval(ping);
      streamClients.delete(client);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

async function api(req: Request, url: URL): Promise<Response> {
  const res = await route(req, url);
  if (url.pathname.startsWith("/api/cameras") && req.method !== "GET" && res.ok) broadcastCameras();
  return res;
}

async function route(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.slice(4);
  const m = req.method;
  const body: any = m === "GET" || m === "DELETE" ? null : await req.json().catch(() => ({}));
  await Bun.sleep(80);

  if (path === "/info" && m === "GET") return json({ version: "0.1.0-mock", apiVersion: 1, needsSetup: users.length === 0, siteName: settings.siteName });
  if (path === "/auth/setup" && m === "POST") {
    if (users.length) return err(409, "已經有帳號了");
    if (!body.username || String(body.password ?? "").length < 8) return err(400, "密碼至少 8 個字元");
    const u: MockUser = { id: nextUserId++, username: body.username, password: hash(body.password), role: "admin", createdAt: now(), lastLoginAt: null };
    users.push(u);
    return withCookie(json({ id: u.id, username: u.username, role: u.role }), startSession(req, u));
  }
  if (path === "/auth/login" && m === "POST") {
    const key = String(body.username);
    if ((fails.get(key) ?? 0) >= 5) return err(429, "嘗試次數過多，請稍後再試");
    const u = users.find((x) => x.username === body.username && x.password === hash(String(body.password)));
    if (!u) {
      fails.set(key, (fails.get(key) ?? 0) + 1);
      return err(401, "帳號或密碼錯誤");
    }
    fails.delete(key);
    return withCookie(json({ id: u.id, username: u.username, role: u.role }), startSession(req, u));
  }
  if (path === "/auth/logout" && m === "POST") {
    const sid = cookieOf(req, "sid");
    if (sid) sessions.delete(sid);
    return noContent();
  }

  const me = principal(req);
  if (!me) return err(401, "請先登入");
  const admin = me.role === "admin";
  const needAdmin = () => (admin ? null : err(403, "需要管理員權限"));

  if (path === "/me") {
    if (m === "GET") return json({ id: me.id, username: me.username, role: me.role });
    if (m === "PUT") {
      if (me.password !== hash(String(body.currentPassword))) return err(403, "目前密碼不正確");
      if (String(body.newPassword ?? "").length < 8) return err(400, "新密碼至少 8 個字元");
      me.password = hash(body.newPassword);
      const cur = cookieOf(req, "sid");
      for (const [k, s] of sessions) if (s.userId === me.id && k !== cur) sessions.delete(k);
      return noContent();
    }
  }
  if (path === "/me/sessions" && m === "GET") {
    const cur = cookieOf(req, "sid");
    return json([...sessions].filter(([, s]) => s.userId === me.id).map(([id, s]) => ({ id, current: id === cur, userAgent: s.ua, ip: s.ip, lastSeenAt: s.lastSeenAt })));
  }
  let mm = path.match(/^\/me\/sessions\/(\w+)$/);
  if (mm && m === "DELETE") {
    sessions.delete(mm[1]!);
    return noContent();
  }
  if (path === "/tokens") {
    if (m === "GET") return json(tokens.filter((t) => t.userId === me.id));
    if (m === "POST") {
      const raw = `cnvr_${crypto.randomUUID().replaceAll("-", "")}`;
      const t = { id: nextTokenId++, userId: me.id, name: String(body.name), prefix: raw.slice(0, 9), createdAt: now(), lastUsedAt: null };
      tokens.push(t);
      return json({ ...t, token: raw }, 201);
    }
  }
  mm = path.match(/^\/tokens\/(\d+)$/);
  if (mm && m === "DELETE") {
    const i = tokens.findIndex((t) => t.id === Number(mm![1]));
    if (i >= 0) tokens.splice(i, 1);
    return noContent();
  }

  if (path === "/cameras" && m === "GET") return json(cams.map((c) => camDto(c, admin)));
  if (path === "/stream" && m === "GET") return streamResponse(admin);
  // 假後端沒有即時影像：每台都回「沒有串流」，介面退回快照
  if (path === "/live" && m === "GET") {
    const ids = (url.searchParams.get("cameras") ?? "").split(",").filter(Boolean);
    const body = new ReadableStream<Uint8Array>({ start: (ctl) => ids.forEach((_, i) => ctl.enqueue(encodeFrame(FrameKind.gone, i))) });
    return new Response(body, { headers: { "content-type": "application/octet-stream" } });
  }
  if (/^\/cameras\/[^/]+\/live\.mp4$/.test(path) && m === "GET") return err(404, "這台攝影機沒有即時畫面");
  mm = path.match(/^\/cameras\/([^/]+)\/snapshot\.jpg$/);
  if (mm && m === "GET") {
    const c = cams.find((x) => x.id === mm![1]);
    if (!c) return err(404, "找不到攝影機");
    const dto = camDto(c, admin);
    if (!dto.online || !existsSync(snapFile)) return err(503, "目前沒有快照");
    return new Response(Bun.file(snapFile), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }
  mm = path.match(/^\/cameras\/([^/]+)\/days$/);
  if (mm && m === "GET") return json(recordedDays(mm[1]!, url.searchParams.get("tz") ?? "UTC"));
  mm = path.match(/^\/cameras\/([^/]+)\/recordings$/);
  if (mm && m === "GET") return json(segmentsIn(mm[1]!, Number(url.searchParams.get("start")), Number(url.searchParams.get("end"))));
  mm = path.match(/^\/segments\/(\d+)$/);
  if (mm && m === "GET") return serveSegment(req, Number(mm[1]));
  const exported = await exportApi(req, url, path, body);
  if (exported) return exported;
  if (path === "/events" && m === "GET") {
    const q = url.searchParams;
    return json(eventsIn(q.get("camera"), Number(q.get("start") ?? 0), Number(q.get("end") ?? Number.MAX_SAFE_INTEGER), Number(q.get("limit") ?? 1000)));
  }
  mm = path.match(/^\/events\/(\d+)\/thumb\.jpg$/);
  if (mm && m === "GET") {
    const id = Number(mm[1]);
    return new Response(Bun.file(thumbFiles[id % thumbFiles.length]!), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });
  }

  const ptzResponse = await ptzApi(req, path, admin, body);
  if (ptzResponse) return ptzResponse;

  const denied = path.startsWith("/cameras") || path.startsWith("/users") || path.startsWith("/settings") || path.startsWith("/system") ? needAdmin() : null;
  if (denied) return denied;

  if (path === "/cameras" && m === "POST") return json(camDto(addCam(body), true), 201);
  if (path === "/cameras/test" && m === "POST") {
    await Bun.sleep(900);
    // 失敗訊息走真後端同一個 explainFailure，兩邊看到的措辭一致：
    // 主機或網址含 fail → 連線被拒絕、含 timeout → 逾時、含 404 → 找不到串流；密碼是 wrong → 帳密錯誤
    const tapo = body.type === "tapo";
    const host = String(tapo ? body.host : body.mainUrl);
    const password = tapo ? String(body.password) : (host.match(/:\/\/[^:@/]*:([^@/]*)@/)?.[1] ?? "");
    const stderr = password === "wrong" ? "401 Unauthorized" : host.includes("fail") ? "Connection refused" : host.includes("404") ? "404 Not Found" : host.includes("weird") ? "method DESCRIBE failed: Weird Thing" : "";
    if (stderr || host.includes("timeout")) return json({ ok: false, error: `主碼流：${explainFailure(stderr, !stderr, tapo)}` } satisfies ProbeResult);
    return json({
      ok: true,
      main: { videoCodec: "h264", width: 2560, height: 1440, fps: 15, audioCodec: "pcm_alaw" },
      sub: body.type === "rtsp" && !body.subUrl ? null : { videoCodec: "h264", width: 640, height: 360, fps: 15, audioCodec: null },
      snapshotJpegBase64: snapB64,
      onvif: onvifProbeOf(body),
    } satisfies ProbeResult);
  }
  mm = path.match(/^\/cameras\/([^/]+)$/);
  if (mm) {
    const c = cams.find((x) => x.id === mm![1]);
    if (!c) return err(404, "找不到攝影機");
    if (m === "PUT") {
      c.config = body;
      return json(camDto(c, true));
    }
    if (m === "DELETE") {
      const recordings = url.searchParams.get("recordings");
      if (recordings !== null && recordings !== "delete") return err(400, "recordings 只接受 delete");
      cams.splice(cams.indexOf(c), 1);
      if (recordings === "delete") usage.delete(c.id);
      return noContent();
    }
  }

  if (path === "/users") {
    if (m === "GET") return json(users.map(userDto));
    if (m === "POST") {
      if (users.some((u) => u.username === body.username)) return err(409, "帳號已存在");
      const u: MockUser = { id: nextUserId++, username: body.username, password: hash(body.password), role: body.role, createdAt: now(), lastLoginAt: null };
      users.push(u);
      return json(userDto(u), 201);
    }
  }
  mm = path.match(/^\/users\/(\d+)$/);
  if (mm) {
    const u = users.find((x) => x.id === Number(mm![1]));
    if (!u) return err(404, "找不到使用者");
    if (m === "PUT") {
      if (body.role && u.role === "admin" && body.role !== "admin" && users.filter((x) => x.role === "admin").length === 1) return err(409, "至少要保留一位管理員");
      if (body.role) u.role = body.role;
      if (body.password) u.password = hash(body.password);
      return json(userDto(u));
    }
    if (m === "DELETE") {
      if (u.id === me.id) return err(409, "不能刪除自己");
      users.splice(users.indexOf(u), 1);
      return noContent();
    }
  }

  if (path === "/settings") {
    if (m === "GET") return json(settings);
    if (m === "PUT") {
      settings = { ...settings, ...body, retention: { ...settings.retention, ...body.retention }, rtsp: { ...settings.rtsp, ...body.rtsp } };
      return json(settings);
    }
  }
  if (path === "/recordings/orphaned" && m === "DELETE") {
    let bytes = 0;
    let segments = 0;
    for (const [id, u] of [...usage]) {
      if (cams.some((c) => c.id === id)) continue;
      bytes += u.bytes;
      segments += Math.round(u.bytes / 1_800_000);
      usage.delete(id);
    }
    return json({ segments, events: 0, bytes });
  }
  if (path === "/system" && m === "GET") {
    const sys: SystemDto = {
      workers,
      disk: { path: settings.storagePath, totalBytes: 2 * 1024 ** 4, freeBytes: 1.6 * 1024 ** 4 },
      usage: [...usage].map(([cameraId, u]) => ({ cameraId: cameraId as CameraId, ...u })),
      logs: Array.from({ length: 60 }, (_, i) => `${new Date(now() - (60 - i) * 5000).toISOString()} INFO tick ${i} worker ok`),
    };
    return json(sys);
  }
  if (path === "/system/diagnostics" && m === "GET") {
    const only = url.searchParams.get("camera");
    if (only && !cams.some((c) => c.id === only)) return err(404, "找不到攝影機");
    const text = buildDiagnostics({
      now: now(),
      version: "0.1.0-mock",
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, uptimeMs: Math.round(process.uptime() * 1000), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      settings,
      cameras: cams.map((c) => {
        const dto = camDto(c, true);
        return { camera: { ...c, createdAt: now(), updatedAt: now() }, online: dto.online, recording: dto.recording, probe: null };
      }),
      only: only as CameraId | null,
      workers,
      restarts: [],
      disk: { path: settings.storagePath, totalBytes: 2 * 1024 ** 4, freeBytes: 1.6 * 1024 ** 4 },
      usage: [],
    });
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  mm = path.match(/^\/system\/workers\/([^/]+)\/restart$/);
  if (mm && m === "POST") {
    const w = workers.find((x) => x.id === decodeURIComponent(mm![1]!));
    if (!w) return err(404, "找不到 worker");
    w.restarts++;
    w.state = "running";
    w.unstable = false;
    w.startedAt = now();
    w.lastRestart = { reason: "manual", at: now(), exitCode: null };
    return noContent();
  }
  return err(404, "找不到路徑");
}

Bun.serve({
  port: PORT,
  routes: { "/": index },
  development: true,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, url);
      } catch (e) {
        return err(500, String(e));
      }
    }
    return err(404, "not found");
  },
});
console.log(`mock NVR on http://localhost:${PORT}`);
if (FRESH) console.log("MOCK_FRESH=1：沒有預建帳號，開啟後會進到初始設定");
else console.log(`示範登入：${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}（管理員），${DEMO_USER.username} / ${DEMO_USER.password}（一般使用者）`);
