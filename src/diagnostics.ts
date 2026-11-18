import type { ProbeResult, StreamInfo, SystemDto } from "./api-types.ts";
import type { Camera, CameraConnection, Settings, WorkerStatus } from "./types.ts";
import type { RestartRecord } from "./workers/restart-log.ts";

export interface DiagnosticsCamera {
  camera: Camera;
  online: boolean;
  recording: boolean;
  /** 最近一次用相同連線設定測試的結果，本次啟動後沒測過就是 null */
  probe: { at: number; result: ProbeResult } | null;
}

export interface DiagnosticsInput {
  now: number;
  version: string;
  runtime: { bun: string; platform: string; arch: string; uptimeMs: number; timeZone: string };
  settings: Settings;
  cameras: DiagnosticsCamera[];
  /** 只看某一台時傳入它的 id，報告只留這台與共用的轉發程序 */
  only: Camera["id"] | null;
  workers: WorkerStatus[];
  restarts: RestartRecord[];
  disk: SystemDto["disk"];
  usage: SystemDto["usage"];
}

const MASK = "***";
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]*@/gi;
const API_TOKEN = /\bcnvr_[A-Za-z0-9_-]{4,}/g;
/** cookie、query string 或設定行裡以常見名稱帶出的值，例如 cnvr_session=…、password: … */
const KEYED_SECRET = /\b((?:cnvr_session|session|token|password|passwd|pwd|secret|authorization)\s*[=:]\s*)(?:Bearer\s+)?[^\s;&,]+/gi;

/** 相機帳密、ONVIF 帳密，以及嵌在網址裡的帳密。帳號也算：它和密碼一樣能拿來登入相機。 */
function secretsOf(conn: CameraConnection): string[] {
  const out: string[] = [];
  const fromUrl = (url: string | undefined) => {
    const m = url?.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#@]*)@/i);
    if (!m) return;
    for (const part of m[1]!.split(":")) {
      out.push(part);
      try {
        out.push(decodeURIComponent(part));
      } catch {}
    }
  };
  if (conn.type === "tapo") out.push(conn.username, conn.password);
  else {
    fromUrl(conn.mainUrl);
    fromUrl(conn.subUrl);
    if (conn.onvif) out.push(conn.onvif.username, conn.onvif.password);
  }
  return out;
}

/** 整份報告最後再過一次：網址帳密、API Token，以及任何設定過的相機帳密字串都換成 ***。 */
export function redact(text: string, cameras: Camera[]): string {
  const secrets = [...new Set(cameras.flatMap((c) => secretsOf(c.config.connection)))]
    // 一兩個字元的字串會把整份報告換得面目全非；網址裡的帳密前面已經用 URL_CREDENTIALS 整段遮掉
    .filter((s) => s.length >= 3)
    // 長的先換，避免短字串先把長密碼切成半截
    .sort((a, b) => b.length - a.length);
  let out = text
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(KEYED_SECRET, `$1${MASK}`)
    .replace(API_TOKEN, `cnvr_${MASK}`);
  for (const s of secrets) out = out.split(s).join(MASK);
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} 天 ${h} 小時` : h ? `${h} 小時 ${m} 分` : `${m} 分 ${s % 60} 秒`;
}

function stream(s: StreamInfo): string {
  return `${s.videoCodec.toUpperCase()} ${s.width}×${s.height} ${s.fps} fps，音訊 ${s.audioCodec?.toUpperCase() ?? "無"}`;
}

function connectionLines(conn: CameraConnection): string[] {
  if (conn.type === "tapo") return [`類型：Tapo，主機 ${conn.host}（主碼流、子碼流、ONVIF 由主機推導）`];
  const lines = [`類型：通用 RTSP，傳輸 ${conn.transport.toUpperCase()}`, `主碼流網址：${conn.mainUrl}`];
  lines.push(`子碼流網址：${conn.subUrl ?? "未設定"}`);
  lines.push(conn.onvif ? `ONVIF：${conn.onvif.host}:${conn.onvif.port}` : "ONVIF：未設定");
  return lines;
}

function cameraBlock(c: DiagnosticsCamera, input: DiagnosticsInput): string[] {
  const { camera } = c;
  const cfg = camera.config;
  const usage = input.usage.find((u) => u.cameraId === camera.id);
  const rec = cfg.record;
  const lines = [
    `### ${cfg.name}（id: ${camera.id}）`,
    `- 啟用：${cfg.enabled ? "是" : "否"}`,
    ...connectionLines(cfg.connection).map((l) => `- ${l}`),
    `- 連線狀態：${!cfg.enabled ? "已停用" : c.online ? "上線（轉發層已收到影像）" : "離線（轉發層沒有收到影像）"}`,
    `- 錄影設定：${rec.enabled ? `開啟，${rec.audio ? "含音訊" : "不含音訊"}，${rec.direct ? "直連相機" : "經轉發層"}` : "關閉"}`,
    `- 目前是否錄影中：${c.recording ? "是" : "否"}`,
  ];
  if (c.probe) {
    const r = c.probe.result;
    const when = `${iso(c.probe.at)}，${duration(input.now - c.probe.at)}前`;
    lines.push(
      r.ok
        ? `- 最近一次測試連線（${when}）：成功；主碼流 ${stream(r.main)}；子碼流 ${r.sub ? stream(r.sub) : "無"}`
        : `- 最近一次測試連線（${when}）：失敗，${r.error}`,
    );
  } else lines.push("- 最近一次測試連線：本次啟動後沒有紀錄，碼流編碼與解析度未知");
  lines.push(
    usage
      ? `- 錄影用量：${bytes(usage.bytes)}，最早一段 ${usage.oldestMs !== null ? iso(usage.oldestMs) : "未知"}`
      : "- 錄影用量：沒有錄影",
  );
  return lines;
}

function workerBlock(w: WorkerStatus, input: DiagnosticsInput): string[] {
  const lines = [
    `### ${w.id}（類型 ${w.kind}）`,
    `- 狀態：${w.state}${w.unstable ? "，不穩定（10 分鐘內重啟超過 10 次）" : ""}`,
    `- PID：${w.pid ?? "無"}，啟動於：${w.startedAt !== null ? `${iso(w.startedAt)}（已執行 ${duration(input.now - w.startedAt)}）` : "未啟動"}`,
    `- 重啟次數：${w.restarts}`,
  ];
  if (w.lastRestart) {
    const r = w.lastRestart;
    lines.push(`- 最近一次重啟：${iso(r.at)}，原因 ${r.reason}，exit code ${r.exitCode ?? "無"}`);
  }
  if (w.stderrTail.length) lines.push("- 輸出尾端：", ...w.stderrTail.map((l) => `    > ${l}`));
  return lines;
}

const workerCamera = (id: string) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : null);

export function buildDiagnostics(input: DiagnosticsInput): string {
  const { settings: s, only } = input;
  const cameras = only ? input.cameras.filter((c) => c.camera.id === only) : input.cameras;
  const keepWorker = (id: string) => only === null || workerCamera(id) === null || workerCamera(id) === only;
  const workers = input.workers.filter((w) => keepWorker(w.id));
  const restarts = input.restarts.filter((r) => keepWorker(r.id)).slice(0, 20);
  const used = input.disk.totalBytes - input.disk.freeBytes;
  const scope = only ? `只包含攝影機「${cameras[0]?.camera.config.name ?? only}」與共用的轉發程序` : "整個系統";

  const lines = [
    "# CookieNVR 診斷資訊",
    "",
    "這是 CookieNVR（自架的家用 NVR，用 MediaMTX 轉發 RTSP、用 ffmpeg 錄影）自動產生的診斷報告，用來排查問題。",
    "所有密碼、相機帳號、網址中的帳密與 API Token 都已換成 ***。可以直接貼給 AI 或技術人員，請對方依此判斷問題與處理方式。",
    "",
    `產生時間：${iso(input.now)}（伺服器時區 ${input.runtime.timeZone}）`,
    `範圍：${scope}`,
    "",
    "## 版本與執行環境",
    `- CookieNVR ${input.version}`,
    `- Bun ${input.runtime.bun}，${input.runtime.platform} ${input.runtime.arch}`,
    `- 本次已執行 ${duration(input.runtime.uptimeMs)}`,
    "",
    `## 攝影機（${cameras.length} 台）`,
    ...(cameras.length ? cameras.flatMap((c) => [...cameraBlock(c, input), ""]) : ["沒有攝影機。", ""]),
    `## 背景程序（${workers.length} 個）`,
    "restream 是 MediaMTX 轉發層，record:<攝影機 id> 是該攝影機的 ffmpeg 錄影程序。",
    "",
    ...(workers.length ? workers.flatMap((w) => [...workerBlock(w, input), ""]) : ["沒有背景程序。", ""]),
    `## 最近的重啟紀錄（最多 20 筆，新的在前）`,
    ...(restarts.length
      ? restarts.flatMap((r) => [
          `- ${iso(r.at)} ${r.id}：原因 ${r.reason}，exit code ${r.exitCode ?? "無"}，signal ${r.signal ?? "無"}，${r.backoffMs ? `${Math.round(r.backoffMs / 1000)} 秒後重試` : "立即重啟"}`,
          ...r.stderrTail.slice(-5).map((l) => `    > ${l}`),
        ])
      : ["沒有重啟紀錄。"]),
    "",
    "## 儲存空間",
    `- 錄影路徑：${input.disk.path}`,
    `- 磁碟：共 ${bytes(input.disk.totalBytes)}，已用 ${bytes(used)}，可用 ${bytes(input.disk.freeBytes)}`,
    `- 錄影合計：${bytes(input.usage.reduce((a, u) => a + u.bytes, 0))}`,
    "",
    "## 設定",
    `- 站點名稱：${s.siteName}`,
    `- 儲存路徑：${s.storagePath}`,
    `- 保留：連續錄影 ${s.retention.continuousDays} 天，事件 ${s.retention.eventDays} 天（0 = 不依天數刪除），最低剩餘空間 ${bytes(s.retention.minFreeBytes)}`,
    `- 對外 RTSP 轉發：${s.rtsp.externalEnabled ? "開啟" : "關閉"}`,
    "",
  ];
  return redact(lines.join("\n"), input.cameras.map((c) => c.camera));
}
