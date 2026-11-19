import type { StreamInfo } from "../../../src/api-types.ts";
import { detectConfigOf } from "../../../src/detect/config.ts";
import type { CameraConfig, CameraConnection, DetectConfig, PtzPrefs } from "../../../src/types.ts";
import { explainProbe, type ProbeField } from "../../camera-form-logic.ts";
import { sensitivityOf } from "../../detect/model.ts";

/** 表單上的文字與開關欄位；偵測與鏡頭控制另外放，因為它們是整包存的 */
export interface Fields {
  type: "tapo" | "rtsp";
  name: string;
  enabled: boolean;
  tapoHost: string;
  tapoUser: string;
  tapoPass: string;
  mainUrl: string;
  subUrl: string;
  transport: "tcp" | "udp";
  onvifOn: boolean;
  ovHost: string;
  ovPort: string;
  ovUser: string;
  ovPass: string;
  recEnabled: boolean;
  recAudio: boolean;
  recDirect: boolean;
}

export type FieldKey = keyof Fields;
export type TextKey = { [K in FieldKey]: Fields[K] extends string ? K : never }[FieldKey];
export type FlagKey = { [K in FieldKey]: Fields[K] extends boolean ? K : never }[FieldKey];

/** 表單的全部內容：存檔、摘要與「未儲存」都只看這一份，和打開頁面時的那份比 */
export interface Draft extends Fields {
  /** 新增中的攝影機沒有偵測設定可調，存檔時用後端預設 */
  detect: DetectConfig | null;
  /** 沒動過、而且原本就沒存過時是 undefined，存檔時不送 */
  ptz: PtzPrefs | undefined;
}

export type CardKey = "basic" | "conn" | "rec" | "detect" | "ptz" | "homekit";

export const DEFAULT_PTZ: PtzPrefs = { mode: "auto", speed: 0.5, invertPan: false, invertTilt: false };

export function draftOf(c: CameraConfig | null): Draft {
  const d: Draft = {
    type: "tapo", name: "", enabled: true,
    tapoHost: "", tapoUser: "", tapoPass: "",
    mainUrl: "", subUrl: "", transport: "tcp",
    onvifOn: false, ovHost: "", ovPort: "80", ovUser: "", ovPass: "",
    recEnabled: true, recAudio: true, recDirect: false,
    detect: null, ptz: undefined,
  };
  if (!c) return d;
  d.name = c.name;
  d.enabled = c.enabled;
  d.recEnabled = c.record.enabled;
  d.recAudio = c.record.audio;
  d.recDirect = c.record.direct;
  const det = detectConfigOf(c);
  d.detect = { ...det, labels: [...det.labels], masks: det.masks.map((m) => ({ points: m.points.map(([x, y]) => [x, y]) })) };
  d.ptz = c.ptz ? { ...c.ptz } : undefined;
  const conn = c.connection;
  if (conn.type === "tapo") {
    d.tapoHost = conn.host;
    d.tapoUser = conn.username;
    d.tapoPass = conn.password;
  } else {
    d.type = "rtsp";
    d.mainUrl = conn.mainUrl;
    d.subUrl = conn.subUrl ?? "";
    d.transport = conn.transport;
    if (conn.onvif) {
      d.onvifOn = true;
      d.ovHost = conn.onvif.host;
      d.ovPort = String(conn.onvif.port);
      d.ovUser = conn.onvif.username;
      d.ovPass = conn.onvif.password;
    }
  }
  return d;
}

/** 表單上的錯誤：summary 寫在送出按鈕旁；field 是要標紅、捲過去的欄位，also 一起標紅但不另外寫字 */
export interface FormError {
  summary: string;
  field?: { key: FieldKey; message: string; also: FieldKey[] };
  /** 沒有對應欄位、但要標成有錯的卡片 */
  card?: CardKey;
  /** 「複製錯誤內容」的文字 */
  copy?: string;
}

const CARD_OF_FIELD: Record<FieldKey, CardKey> = {
  name: "basic", enabled: "basic",
  type: "conn", tapoHost: "conn", tapoUser: "conn", tapoPass: "conn", mainUrl: "conn", subUrl: "conn", transport: "conn",
  onvifOn: "conn", ovHost: "conn", ovPort: "conn", ovUser: "conn", ovPass: "conn", recDirect: "conn",
  recEnabled: "rec", recAudio: "rec",
};

export function errorCard(e: FormError | null): CardKey | null {
  if (!e) return null;
  return e.card ?? (e.field ? CARD_OF_FIELD[e.field.key] : null);
}

export const invalidFields = (e: FormError | null): FieldKey[] => (e?.field ? [e.field.key, ...e.field.also] : []);

const fieldError = (key: FieldKey, message: string, summary = "請修正標示的欄位"): FormError => ({ summary, field: { key, message, also: [] } });

export function toConnection(d: Fields): { conn: CameraConnection } | { error: FormError } {
  if (d.type === "tapo") {
    if (!d.tapoHost.trim()) return { error: fieldError("tapoHost", "請填寫相機的 IP 位址") };
    if (!d.tapoUser.trim()) return { error: fieldError("tapoUser", "請填寫相機帳號") };
    if (!d.tapoPass) return { error: fieldError("tapoPass", "請填寫相機密碼") };
    return { conn: { type: "tapo", host: d.tapoHost.trim(), username: d.tapoUser.trim(), password: d.tapoPass } };
  }
  const main = d.mainUrl.trim();
  if (!/^rtsps?:\/\/\S+$/i.test(main)) return { error: fieldError("mainUrl", "請填寫以 rtsp:// 開頭的串流網址") };
  const sub = d.subUrl.trim();
  if (sub && !/^rtsps?:\/\/\S+$/i.test(sub)) return { error: fieldError("subUrl", "低畫質串流網址需以 rtsp:// 開頭") };
  const conn: CameraConnection = { type: "rtsp", mainUrl: main, transport: d.transport };
  if (sub) conn.subUrl = sub;
  if (d.onvifOn) {
    const port = Number(d.ovPort);
    if (!d.ovHost.trim()) return { error: fieldError("ovHost", "請填寫 ONVIF 主機") };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: fieldError("ovPort", "ONVIF 連接埠需為 1 到 65535 的數字") };
    conn.onvif = { host: d.ovHost.trim(), port, username: d.ovUser, password: d.ovPass };
  }
  return { conn };
}

/** 連線設定的比較鍵；填得不完整時是 null（一定要重新測試） */
export function connKey(d: Fields): string | null {
  const r = toConnection(d);
  return "conn" in r ? JSON.stringify(r.conn) : null;
}

/** 送出前的檢查；過了就是要存的設定與連線 */
export function validate(d: Draft, keep: Pick<CameraConfig, "detect" | "homekit"> | null, homekit: CameraConfig["homekit"]): { config: CameraConfig; conn: CameraConnection } | { error: FormError } {
  if (!d.name.trim()) return { error: fieldError("name", "請幫這台攝影機取個名稱") };
  const r = toConnection(d);
  if ("error" in r) return r;
  const config: CameraConfig = {
    name: d.name.trim(),
    enabled: d.enabled,
    connection: r.conn,
    record: { enabled: d.recEnabled, audio: d.recAudio, direct: d.recDirect },
    detect: d.detect ?? keep?.detect,
    homekit,
  };
  if (d.ptz) config.ptz = d.ptz;
  return { config, conn: r.conn };
}

/** 哪幾張卡片和打開頁面時不一樣 */
export function dirtyCards(d: Draft, saved: Draft): Set<CardKey> {
  const out = new Set<CardKey>();
  const changed = (keys: FieldKey[]) => keys.some((k) => d[k] !== saved[k]);
  if (changed(["name", "enabled"])) out.add("basic");
  if (connKey(d) !== connKey(saved) || changed(["recDirect"]) || (d.type === "rtsp" && changed(["transport", "onvifOn"]))) out.add("conn");
  if (changed(["recEnabled", "recAudio"])) out.add("rec");
  if (JSON.stringify(d.detect) !== JSON.stringify(saved.detect)) out.add("detect");
  if (JSON.stringify(d.ptz ?? null) !== JSON.stringify(saved.ptz ?? null)) out.add("ptz");
  return out;
}

/** 網址裡的主機名稱，不含帳密與路徑 */
export function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^rtsps?:/i, "http:")).hostname;
  } catch {
    return "";
  }
}

const SENS = { low: "低", medium: "中", high: "高", custom: "自訂" } as const;

export const basicSummary = (d: Draft, existing: boolean) => `${d.name.trim() || "還沒取名"}${existing ? ` · ${d.enabled ? "已啟用" : "已停用"}` : ""}`;

export function connSummary(d: Draft): string {
  const host = d.type === "tapo" ? d.tapoHost.trim() : hostOf(d.mainUrl);
  return `${d.type === "tapo" ? "Tapo" : "其他攝影機"} · ${host || "還沒填位址"}${d.type === "rtsp" && d.onvifOn ? " · 使用 ONVIF" : ""}`;
}

export const connAdvancedSummary = (d: Draft) =>
  [d.type === "rtsp" ? d.transport.toUpperCase() : null, d.type === "rtsp" && d.onvifOn ? "使用 ONVIF" : null, d.recDirect ? "錄影直接連到相機" : null].filter(Boolean).join(" · ") || "大多數情況不需要調整";

/** 連線的進階設定有不是預設值的東西時，一打開就展開 */
export const connAdvancedOpen = (d: Draft) => (d.type === "rtsp" && (d.transport !== "tcp" || d.onvifOn)) || d.recDirect;

export const recSummary = (d: Draft) => (!d.recEnabled ? "不錄影" : d.recAudio ? "全天候錄影 · 錄下聲音" : "全天候錄影 · 不錄聲音");

/** objects 是物件辨識的一句話（系統沒開物件辨識時是 null） */
export function detectSummary(d: DetectConfig, objects: string | null): string {
  if (!d.enabled) return "未開啟";
  const parts = ["已開啟"];
  if (d.source === "onvif") parts.push("相機偵測");
  else {
    if (d.source === "both") parts.push("畫面變化＋相機偵測");
    parts.push(`靈敏度${SENS[sensitivityOf(d.threshold)]}`);
    if (d.masks.length) parts.push(`${d.masks.length} 個排除區域`);
  }
  if (objects) parts.push(objects);
  return parts.join(" · ");
}

export function describeConn(conn: CameraConnection): string {
  return conn.type === "tapo" ? `Tapo，主機 ${conn.host}` : `RTSP，主機 ${hostOf(conn.mainUrl)}，傳輸 ${conn.transport.toUpperCase()}${conn.subUrl ? "，有低畫質串流" : ""}${conn.onvif ? "，有 ONVIF" : ""}`;
}

/** 測試連線失敗：錯誤掛在對應的欄位，原文只放進「複製錯誤內容」 */
export function probeFailure(conn: CameraConnection, error: string): FormError {
  const tapo = conn.type === "tapo";
  const help = explainProbe(error, conn.type);
  const target: Record<NonNullable<ProbeField>, [FieldKey, FieldKey[]]> = {
    host: [tapo ? "tapoHost" : "mainUrl", []],
    url: [tapo ? "tapoHost" : "mainUrl", []],
    credentials: tapo ? ["tapoPass", ["tapoUser"]] : ["mainUrl", []],
    subUrl: ["subUrl", []],
  };
  return {
    summary: help.field ? "連不上這台攝影機，所以還沒儲存" : help.message,
    field: help.field ? { key: target[help.field][0], message: help.message, also: target[help.field][1] } : undefined,
    card: "conn",
    copy: `CookieNVR 測試攝影機連線失敗\n攝影機：${describeConn(conn)}\n錯誤：${error}\n（帳號密碼已省略）`,
  };
}

function quality(w: number): string {
  if (w >= 3800) return "4K";
  if (w >= 2500) return "2K";
  if (w >= 1900) return "1080p";
  if (w >= 1260) return "720p";
  return "";
}

export function streamLine(s: StreamInfo): string {
  const q = quality(s.width);
  return [q ? `${q}（${s.width}×${s.height}）` : `${s.width}×${s.height}`, `${Math.round(s.fps * 10) / 10} fps`, s.videoCodec.toUpperCase().replace("HEVC", "H.265").replace("H264", "H.264"), s.audioCodec ? "有聲音" : "無聲音"].join("・");
}
