import type { CodecCheckDto, DecodeStatusDto, ProbeResult, StreamInfo, SystemDto } from "./api-types.ts";
import { detectConfigOf } from "./detect/config.ts";
import type { DetectDiagnostics } from "./detect/manager.ts";
import type { HomekitCameraDiagnostics, HomekitDiagnostics } from "./homekit/manager.ts";
import { CODEC_LABEL, CODECS } from "./hwcodec/commands.ts";
import type { ProbeReport } from "./hwcodec/probe.ts";
import { metricsReport } from "./metrics/report.ts";
import type { MetricsDiagnostics } from "./metrics/sampler.ts";
import type { ObjectsDiagnostics } from "./objects/service.ts";
import type { PtzDiagnostics } from "./ptz/hub.ts";
import type { StateDiagnostics } from "./states/service.ts";
import type { Camera, CameraConnection, Settings, WorkerStatus } from "./types.ts";
import type { RestartRecord } from "./workers/restart-log.ts";

export interface DiagnosticsCamera {
  camera: Camera;
  online: boolean;
  recording: boolean;
  /** 最近一次用相同連線設定測試的結果，本次啟動後沒測過就是 null */
  probe: { at: number; result: ProbeResult } | null;
  /** ONVIF 與 PTZ 的現況；沒有提供時報告不列這一項 */
  ptz?: PtzDiagnostics;
  /** 動作偵測的現況；沒有提供時報告不列這一項 */
  detect?: { state: DetectDiagnostics | null; eventsLast24h: number };
  /** Apple 家庭（HKSV）的現況；沒有提供時報告不列這一項 */
  homekit?: HomekitCameraDiagnostics;
}

export interface DiagnosticsInput {
  now: number;
  version: string;
  runtime: { bun: string; platform: string; arch: string; uptimeMs: number; timeZone: string };
  settings: Settings;
  cameras: DiagnosticsCamera[];
  /** 只看某一台時傳入它的 id，報告只留這台與共用的轉發程序 */
  only: Camera["id"] | null;
  /** 物件辨識；沒有提供時報告不列這一節 */
  objects?: ObjectsDiagnostics;
  /** 狀態辨識；沒有提供或沒有任何感應器時報告不列這一節 */
  states?: StateDiagnostics;
  workers: WorkerStatus[];
  restarts: RestartRecord[];
  disk: SystemDto["disk"];
  dataDisk: SystemDto["dataDisk"];
  usage: SystemDto["usage"];
  elsewhere: SystemDto["elsewhere"];
  homekit?: Pick<HomekitDiagnostics, "systemEnabled" | "workerConnected" | "lastHeartbeatAt">;
  /** CPU、記憶體、GPU 與各程序的用量；沒有提供時報告不列這一節 */
  metrics?: MetricsDiagnostics;
  /** 影像硬體解碼：試跑結果（沒跑過為 null）與每台的實際解碼方式 */
  video?: { report: ProbeReport | null; status: DecodeStatusDto };
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

function ptzLines(p: PtzDiagnostics, now: number): string[] {
  const caps =
    p.caps === "unknown"
      ? "尚未連上過，能力未知"
      : p.caps === "no-ptz"
        ? "ONVIF 可用，相機沒有 PTZ"
        : `有 PTZ（${[p.caps.continuous && "持續移動", p.caps.relative && "相對移動"].filter(Boolean).join("、") || "無移動方式"}；${p.caps.zoom ? "有" : "沒有"}變焦；預置點上限 ${p.caps.maxPresets ?? "未回報"}）`;
  const lines = [
    `- ONVIF／PTZ：${p.configured ? caps : "未設定 ONVIF"}`,
    `- PTZ 偏好：移動模式 ${p.prefs.mode}，預設速度 ${p.prefs.speed}${p.prefs.invertPan ? "，左右反轉" : ""}${p.prefs.invertTilt ? "，上下反轉" : ""}`,
  ];
  if (p.lastError) lines.push(`- ONVIF 最近的錯誤：${p.lastError.kind}（${iso(p.lastError.at)}，${duration(now - p.lastError.at)}前）`);
  else if (p.configured) lines.push("- ONVIF 最近的錯誤：無");
  return lines;
}

const SOURCE_TEXT = { pixel: "畫面差分", onvif: "相機事件（ONVIF）", both: "畫面差分＋相機事件" } as const;

function subscriberLine(s: NonNullable<DetectDiagnostics["onvif"]>, now: number): string {
  const st = s.status;
  const state =
    st.state === "active"
      ? `active（${duration(now - st.since)}前建立）`
      : st.state === "backoff"
        ? `backoff，第 ${st.attempt} 次重試，錯誤 ${st.error.kind}${st.error.kind === "auth" ? "（請檢查相機帳密）" : ""}`
        : st.state === "unsupported"
          ? "unsupported（相機不支援 PullPoint 事件，已停止訂閱）"
          : st.state;
  const last = s.lastEvent ? `；最近一次通知 ${s.lastEvent.topic}=${s.lastEvent.active}（${duration(now - s.lastEvent.at)}前）` : "；還沒收到通知";
  return `- ONVIF 事件訂閱：${state}${last}`;
}

function detectLines(d: NonNullable<DiagnosticsCamera["detect"]>, now: number): string[] {
  const st = d.state;
  if (!st) return ["- 動作偵測：攝影機停用，沒有執行"];
  const c = st.config;
  const lines = [
    `- 動作偵測：${c.enabled ? `開啟，來源 ${SOURCE_TEXT[c.source]}` : "關閉（仍解碼供快照）"}；像素門檻 ${c.threshold}，最小面積 ${(c.minArea * 100).toFixed(2)}%，冷卻 ${c.cooldownSec} 秒，遮罩 ${c.masks.length} 個`,
    `- 偵測畫面：${st.lastFrame ? `最近一張 ${duration(now - st.lastFrame.at)}前，狀態 ${st.lastFrame.state}，分數 ${st.lastFrame.score?.toFixed(4) ?? "—"}；60 秒內最高 ${st.peakScore?.toFixed(4) ?? "—"}` : "還沒收到畫面"}${st.paused ? "；鏡頭移動中暫停" : ""}`,
    `- 快照：${st.jpegAt ? `${duration(now - st.jpegAt)}前更新` : "還沒有"}`,
  ];
  if (c.enabled && c.source !== "pixel") lines.push(st.onvif ? subscriberLine(st.onvif, now) : "- ONVIF 事件訂閱：沒有設定 ONVIF，相機事件不會觸發");
  lines.push(`- 最近 24 小時事件：${d.eventsLast24h} 筆`);
  return lines;
}

function homekitLines(h: HomekitCameraDiagnostics, now: number): string[] {
  if (!h.enabled) return ["- Apple 家庭（HKSV）：這台沒有開啟"];
  const lines = [
    `- Apple 家庭（HKSV）：開啟；配件 port ${h.identity?.port ?? "未分配"}，device id ${h.identity?.deviceId ?? "無"}；${h.paired ? "已配對" : "尚未配對"}`,
  ];
  const c = h.check;
  if (!c) lines.push("- HKSV 主碼流檢查：還沒有結果");
  else if ("error" in c) lines.push(`- HKSV 主碼流檢查（${duration(now - c.at)}前）：讀取失敗，${c.error}`);
  else {
    const r = c.result;
    lines.push(
      `- HKSV 主碼流檢查（${duration(now - c.at)}前）：${r.videoCodec ?? "沒有影像"} ${r.width ?? "?"}×${r.height ?? "?"}，關鍵幀間隔 ${r.keyframeIntervalSec ?? "未知（檢查時間內不到兩個關鍵幀）"} 秒，音訊 ${r.audioCodec ?? "無"}`,
    );
  }
  const w = h.worker;
  if (!w) lines.push("- HKSV 配件：homekit worker 沒有回報這台（未連線或未發布）");
  else {
    lines.push(
      `- HKSV 配件：${w.published ? "已發布（mDNS 廣播中）" : `未發布${w.error ? `，錯誤 ${w.error}` : ""}`}；安全錄影 ${w.recording.active ? "已開啟" : "未開啟"}，${w.recording.configured ? "中樞已選定錄影設定" : "中樞尚未選定錄影設定"}，預緩衝 ${w.recording.prebufferMs} ms${w.recording.streaming ? "，正在送錄影串流" : ""}`,
    );
    for (const [kind, label] of [["snapshot", "快照"], ["live", "即時觀看"], ["recording", "錄影串流"]] as const) {
      const r = w.requests[kind];
      lines.push(r ? `- 最近一次${label}請求（${duration(now - r.at)}前）：${r.ok ? "成功" : "失敗"}，${r.detail}` : `- 最近一次${label}請求：本次啟動後沒有`);
    }
  }
  if (h.sessions.length) lines.push(`- 進行中的 HomeKit 串流：${h.sessions.join("、")}`);
  return lines;
}

function onvifProbeLine(r: Extract<ProbeResult, { ok: true }>["onvif"]): string {
  if (r.state === "unconfigured") return "ONVIF 未設定";
  if (r.state === "available") return `ONVIF 可用，${r.ptz ? "有" : "沒有"} PTZ`;
  return `ONVIF 不可用（${r.kind}）`;
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
        ? `- 最近一次測試連線（${when}）：成功；主碼流 ${stream(r.main)}；子碼流 ${r.sub ? stream(r.sub) : "無"}；${onvifProbeLine(r.onvif)}`
        : `- 最近一次測試連線（${when}）：失敗，${r.error}`,
    );
    if (!r.ok && r.detail) lines.push(...r.detail.split("\n").map((l) => `    > ${l}`));
  } else lines.push("- 最近一次測試連線：本次啟動後沒有紀錄，碼流編碼與解析度未知");
  if (c.ptz) lines.push(...ptzLines(c.ptz, input.now));
  if (c.detect) lines.push(...detectLines(c.detect, input.now));
  if (c.homekit) lines.push(...homekitLines(c.homekit, input.now));
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

const MODE_TEXT = { off: "不辨識", annotate: "標註", filter: "過濾" } as const;

const checkText = (c: CodecCheckDto) => (c.ok ? `可以（${c.ms} ms）` : `不行：${c.reason}`);

function videoLines(v: NonNullable<DiagnosticsInput["video"]>, cameras: DiagnosticsCamera[], now: number): string[] {
  const lines = [`- 設定：${v.status.requested}（auto = 自動，cpu = 處理器）`];
  const r = v.report;
  if (!r) lines.push("- 顯示卡試跑：還沒跑過（設定成 cpu 時不跑）");
  else {
    lines.push(`- 顯示卡試跑：${iso(r.at)}，${duration(now - r.at)}前；${r.ffmpeg}`);
    if (r.devices.length === 0) lines.push("- 沒有找到可做影片硬體解碼的顯示卡");
    for (const d of r.devices) {
      const where = d.api.type === "vaapi" ? `VAAPI ${d.api.node}` : d.api.type === "cuda" ? `CUDA ${d.api.uuid ?? `#${d.api.index}`}` : "VideoToolbox";
      lines.push(`- ${d.id}（${d.name}，${where}${d.pci ? `，PCI ${d.pci}` : ""}）`);
      for (const [label, set] of [["解碼", d.decode], ["編碼", d.encode]] as const) {
        for (const c of CODECS) {
          const check = set[c];
          lines.push(`    - ${CODEC_LABEL[c]} ${label}：${checkText(check)}`);
          if (!check.ok) lines.push(...check.detail.split("\n").map((l) => `      > ${l}`));
        }
      }
    }
  }
  for (const c of v.status.cameras) {
    const name = cameras.find((x) => x.camera.id === c.cameraId)?.camera.config.name ?? c.cameraId;
    const using = c.device === null ? "處理器" : `${c.device}${c.confirmed ? "（已確認有畫面）" : "（啟動中）"}`;
    lines.push(`- ${name}：${using}${c.fallback ? `；${c.fallback.reason}` : ""}`);
    if (c.fallback) lines.push(...c.fallback.detail.split("\n").map((l) => `    > ${l}`));
  }
  return lines;
}

function objectsLines(o: ObjectsDiagnostics, cameras: DiagnosticsCamera[], now: number): string[] {
  const st = o.status;
  if (!o.settings.enabled) return ["- 關閉（detector worker 沒有執行）"];
  const lines = [
    `- 設定：推論裝置 ${o.requested}，模型 ${o.settings.model}，每台每秒辨識 ${o.settings.fps} 次`,
    `- 狀態：${st.state}${st.device ? `，實際使用 ${st.device.name}（${st.device.id}）` : ""}${st.paused ? "，測速中暫停辨識" : ""}`,
  ];
  if (st.fallback) lines.push(`- 沒有用指定裝置的原因：${st.fallback.reason}；細節：${st.fallback.detail || "無"}`);
  if (st.error) lines.push(`- 模型錯誤：${st.error}${o.errorDetail ? `；細節：${o.errorDetail}` : ""}`);
  if (o.ready) {
    const r = o.ready;
    lines.push(`- 模型：${r.model.file}，格式 ${r.model.format}，輸入 ${r.model.input.join("×")}；載入 ${r.loadMs} ms；providers ${r.providers.join(", ")}；CPU 執行緒 ${r.threads}`);
    lines.push(`- 偵測到的裝置：${r.devices.map((d) => `${d.id}（${d.name}）`).join("、")}`);
    lines.push(`- 載入嘗試：${JSON.stringify(r.attempts)}`);
  }
  if (st.gpu) lines.push(`- GPU 使用率 ${st.gpu.utilPercent}%，顯示記憶體 ${st.gpu.memoryUsedMb}／${st.gpu.memoryTotalMb} MB`);
  lines.push(
    `- 推論延遲：${st.latencyMs ? `最近 ${st.latencyMs.last} ms，平均 ${st.latencyMs.avg} ms，最慢 ${st.latencyMs.max} ms（最近 50 張，含 JPEG 解碼與前後處理）` : "還沒有推論過"}`,
    `- 本次啟動以來推論 ${st.processed} 張，排隊超過 1 秒被丟掉 ${st.dropped} 張，目前佇列 ${o.queued} 張；最近 60 秒每秒 ${st.rateFps} 張，最近 5 分鐘丟掉比例 ${st.dropRatio === null ? "—（畫面太少）" : `${Math.round(st.dropRatio * 100)}%`}`,
  );
  if (st.warning) lines.push(`- 提醒：${st.warning}`);
  const b = o.benchmark;
  if (b) {
    const res = b.results.map((r) => (r.ok ? `${r.name}（${r.device}）每秒 ${r.fps} 張、平均 ${r.msMean} ms、約 ${r.cameras} 台` : `${r.name}（${r.device}）失敗：${r.error}`));
    lines.push(`- 最近一次測速：${iso(b.startedAt)}，${b.state}${b.stale ? "（已過期：換了模型或裝置）" : ""}，模型 ${b.model}，以每台每秒 ${b.perCameraFps} 次換算；${res.join("；") || "沒有結果"}${b.error ? `；錯誤：${b.error}` : ""}`);
  }
  if (o.probe) lines.push(`- 環境偵測：${JSON.stringify(o.probe)}`);
  for (const c of cameras) {
    const d = detectConfigOf(c.camera.config);
    const last = o.recent.find((r) => r.cameraId === c.camera.id);
    const seen = last ? `；最近一次結果（${duration(now - last.at)}前）：${last.detections.map((x) => `${x.label} ${x.score.toFixed(2)}`).join("、") || "沒有物件"}` : "";
    lines.push(`- ${c.camera.config.name}：${d.enabled ? MODE_TEXT[d.objectMode] : "偵測關閉"}，關注 ${d.labels.join("、") || "無"}，門檻 ${d.objectScore}${seen}`);
  }
  return lines;
}

function statesLines(st: StateDiagnostics, cameras: DiagnosticsCamera[], now: number): string[] {
  const w = st.worker;
  const lines = [`- classifier worker：${w.phase}${w.backbone ? `，骨幹 ${w.backbone}，載入 ${w.loadMs} ms` : ""}${w.error ? `；錯誤：${w.error}${w.detail ? `（${w.detail}）` : ""}` : ""}`];
  const names = new Map(cameras.map((c) => [c.camera.id, c.camera.config.name]));
  for (const s of st.sensors.filter((x) => names.has(x.cameraId))) {
    const c = s.config;
    lines.push(
      `- 「${c.name}」（${s.id}，攝影機 ${names.get(s.cameraId)}）：類別 ${c.classes.join("／")}，區域 [${c.crop.map((n) => n.toFixed(3)).join(", ")}]，門檻 ${c.threshold}，每 ${c.intervalSec || "—"} 秒${c.onMotion ? "＋區域有變化時" : ""}${c.enabled ? "" : "，已暫停"}`,
      `  - 狀態：${s.state ?? "未知"}${s.since ? `（${duration(now - s.since)}前切換）` : ""}${s.candidate ? `，驗證中 ${s.candidate.label} ×${s.candidate.count}` : ""}${s.problem ? `；沒在辨識：${s.problem.code}（${s.problem.message}）` : ""}`,
      `  - 圖片：待標記 ${s.images.pending}，已標記 ${s.images.labeled.map((l) => `${l.label} ${l.count}`).join("、")}`,
    );
    const m = s.model;
    if (m) {
      const v = m.validation;
      lines.push(
        `  - 模型：${iso(m.trainedAt)} 訓練，${m.backbone}，類別 ${m.classes.join("／")}，張數 ${m.counts.map((x) => `${x.label} ${x.count}`).join("、")}，訓練 ${m.trainMs} ms；${v ? `${v.folds}-fold 交叉驗證準確度 ${(v.accuracy * 100).toFixed(1)}%，混淆矩陣 ${JSON.stringify(v.confusion)}` : "沒有交叉驗證（某類少於 2 張）"}`,
      );
    } else lines.push("  - 模型：還沒訓練");
    if (s.job) lines.push(`  - 最近的背景工作：${s.job.kind} ${s.job.state}${"error" in s.job ? `：${s.job.error}` : "message" in s.job ? `：${s.job.message}` : ""}`);
    if (s.recent.length) lines.push(`  - 最近讀數：${s.recent.map((r) => `${duration(now - r.at)}前 ${r.label} ${r.score.toFixed(2)}`).join("、")}`);
  }
  return lines;
}

/** "record:<id>"、"live:<id>:main"、"hksv-live:<id>:<session>" → 攝影機 id */
const workerCamera = (id: string) => id.split(":")[1] ?? null;

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
    ...(input.objects ? ["## 物件辨識（YOLO）", ...objectsLines(input.objects, cameras, input.now), ""] : []),
    ...(input.states?.sensors.length ? ["## 狀態辨識", ...statesLines(input.states, cameras, input.now), ""] : []),
    ...(input.video ? ["## 影像硬體解碼（detect worker）", ...videoLines(input.video, cameras, input.now), ""] : []),
    `## 攝影機（${cameras.length} 台）`,
    ...(cameras.length ? cameras.flatMap((c) => [...cameraBlock(c, input), ""]) : ["沒有攝影機。", ""]),
    `## 背景程序（${workers.length} 個）`,
    "restream 是 MediaMTX 轉發層，record:<攝影機 id> 是該攝影機的 ffmpeg 錄影程序；homekit 是 Apple 家庭（HAP-NodeJS）程序，hksv-live／hksv-record 是家庭 App 觀看與安全錄影用的 ffmpeg。",
    "detect:<攝影機 id> 是解碼與動作偵測，detector 是物件辨識（Python＋ONNX Runtime），classifier 是狀態辨識（同一套 Python 環境，固定用 CPU）。",
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
    `- 錄影合計（目前位置）：${bytes(input.usage.reduce((a, u) => a + u.bytes, 0))}`,
    ...input.elsewhere.map((e) => `- 其他位置的錄影：${e.path}，${bytes(e.bytes)}`),
    `- 資料目錄：${input.dataDisk.path}，${
      input.dataDisk.sameAsRecordings
        ? "和錄影在同一顆硬碟"
        : `另一顆硬碟，共 ${bytes(input.dataDisk.totalBytes)}，可用 ${bytes(input.dataDisk.freeBytes)}`
    }`,
    "",
    ...(input.metrics ? metricsReport(input.metrics) : []),
    "## 設定",
    `- 站點名稱：${s.siteName}`,
    `- 儲存路徑：${s.storagePath}`,
    `- 保留：連續錄影 ${s.retention.continuousDays} 天，事件 ${s.retention.eventDays} 天（0 = 不依天數刪除），最低剩餘空間 ${bytes(s.retention.minFreeBytes)}`,
    `- 對外 RTSP 轉發：${s.rtsp.externalEnabled ? "開啟" : "關閉"}`,
    `- Apple 家庭（HKSV，實驗性）：${s.homekit.enabled ? `開啟，配件 port 從 ${s.homekit.basePort} 起` : "關閉"}${
      input.homekit && s.homekit.enabled
        ? `；homekit worker ${input.homekit.workerConnected ? "已連線" : "未連線"}，最近心跳 ${input.homekit.lastHeartbeatAt !== null ? `${duration(input.now - input.homekit.lastHeartbeatAt)}前` : "無"}`
        : ""
    }`,
    "",
  ];
  return redact(lines.join("\n"), input.cameras.map((c) => c.camera));
}
