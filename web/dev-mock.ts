// 開發用假後端：bun run web/dev-mock.ts，之後開 http://localhost:48765
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CameraDto, EventDto, ProbeResult, SegmentDto, SystemDto, UserDto } from "../src/api-types.ts";
import type { CameraConfig, CameraId, Role, Settings, WorkerStatus } from "../src/types.ts";
import index from "./index.html";

const PORT = 48765;
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
addCam({ name: "車庫 <script>alert(1)</script>", enabled: true, connection: { type: "rtsp", mainUrl: "rtsp://u:p@192.168.1.60/s1", subUrl: "rtsp://u:p@192.168.1.60/s2", transport: "tcp" }, record: { enabled: true, audio: false, direct: true } });
addCam({ name: "前門", enabled: true, connection: { type: "tapo", host: "192.168.1.52", username: "nvr", password: "secret123" }, record: { enabled: true, audio: true, direct: false } });
addCam({ name: "後院（停用）", enabled: false, connection: { type: "rtsp", mainUrl: "rtsp://192.168.1.61/s1", transport: "udp" }, record: { enabled: false, audio: false, direct: false } });

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

async function api(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.slice(4);
  const m = req.method;
  const body: any = m === "GET" || m === "DELETE" ? null : await req.json().catch(() => ({}));
  await Bun.sleep(80);

  if (path === "/info" && m === "GET") return json({ version: "0.1.0-mock", apiVersion: 1, needsSetup: users.length === 0 });
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
  if (path === "/events" && m === "GET") {
    const q = url.searchParams;
    return json(eventsIn(q.get("camera"), Number(q.get("start") ?? 0), Number(q.get("end") ?? Number.MAX_SAFE_INTEGER), Number(q.get("limit") ?? 1000)));
  }
  mm = path.match(/^\/events\/(\d+)\/thumb\.jpg$/);
  if (mm && m === "GET") {
    const id = Number(mm[1]);
    return new Response(Bun.file(thumbFiles[id % thumbFiles.length]!), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });
  }

  const denied = path.startsWith("/cameras") || path.startsWith("/users") || path.startsWith("/settings") || path.startsWith("/system") ? needAdmin() : null;
  if (denied) return denied;

  if (path === "/cameras" && m === "POST") return json(camDto(addCam(body), true), 201);
  if (path === "/cameras/test" && m === "POST") {
    await Bun.sleep(900);
    const host = body.type === "tapo" ? body.host : body.mainUrl;
    if (String(host).includes("fail")) return json({ ok: false, error: "無法連線到相機：Connection refused" } satisfies ProbeResult);
    return json({
      ok: true,
      main: { videoCodec: "h264", width: 2560, height: 1440, fps: 15, audioCodec: "pcm_alaw" },
      sub: body.type === "rtsp" && !body.subUrl ? null : { videoCodec: "h264", width: 640, height: 360, fps: 15, audioCodec: null },
      snapshotJpegBase64: snapB64,
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
      cams.splice(cams.indexOf(c), 1);
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
  if (path === "/system" && m === "GET") {
    const sys: SystemDto = {
      workers,
      disk: { path: settings.storagePath, totalBytes: 2 * 1024 ** 4, freeBytes: 1.6 * 1024 ** 4 },
      usage: cams.slice(0, 2).map((c, i) => ({ cameraId: c.id, bytes: (180 - i * 90) * 1024 ** 3 })),
      logs: Array.from({ length: 60 }, (_, i) => `${new Date(now() - (60 - i) * 5000).toISOString()} INFO tick ${i} worker ok`),
    };
    return json(sys);
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
