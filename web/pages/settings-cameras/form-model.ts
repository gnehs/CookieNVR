import { plural, t } from "@lingui/core/macro";
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

/** 表單上各自打開、各自儲存的區塊 */
export type SectionKey = "basic" | "conn" | "rec" | "detect" | "ptz";

/** 每個區塊管哪些欄位：儲存一個區塊時只把這些欄位換進目前的設定 */
const SECTION_FIELDS: Record<SectionKey, readonly (keyof Draft)[]> = {
  basic: ["name", "enabled"],
  conn: ["type", "tapoHost", "tapoUser", "tapoPass", "mainUrl", "subUrl", "transport", "onvifOn", "ovHost", "ovPort", "ovUser", "ovPass", "recDirect"],
  rec: ["recEnabled", "recAudio"],
  detect: ["detect"],
  ptz: ["ptz"],
};

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
  /** 沒有對應欄位、但要標成有錯的區塊 */
  card?: SectionKey;
  /** 「複製錯誤內容」的文字 */
  copy?: string;
}

const SECTION_OF_FIELD = Object.fromEntries(
  (Object.entries(SECTION_FIELDS) as [SectionKey, readonly (keyof Draft)[]][]).flatMap(([key, fields]) => fields.map((f) => [f, key])),
) as Record<FieldKey, SectionKey>;

export function errorCard(e: FormError | null): SectionKey | null {
  if (!e) return null;
  return e.card ?? (e.field ? SECTION_OF_FIELD[e.field.key] : null);
}

export const invalidFields = (e: FormError | null): FieldKey[] => (e?.field ? [e.field.key, ...e.field.also] : []);

/** 改了標紅的欄位、或換了攝影機類型，原本的錯誤就不再適用 */
export const clearsError = (e: FormError | null, patch: Partial<Draft>) => !!e && ("type" in patch || invalidFields(e).some((k) => k in patch));

const fieldError = (key: FieldKey, message: string, summary = t`Fix the highlighted fields`): FormError => ({ summary, field: { key, message, also: [] } });

export function toConnection(d: Fields): { conn: CameraConnection } | { error: FormError } {
  if (d.type === "tapo") {
    if (!d.tapoHost.trim()) return { error: fieldError("tapoHost", t`Enter the camera's IP address`) };
    if (!d.tapoUser.trim()) return { error: fieldError("tapoUser", t`Enter the camera username`) };
    if (!d.tapoPass) return { error: fieldError("tapoPass", t`Enter the camera password`) };
    return { conn: { type: "tapo", host: d.tapoHost.trim(), username: d.tapoUser.trim(), password: d.tapoPass } };
  }
  const main = d.mainUrl.trim();
  if (!/^rtsps?:\/\/\S+$/i.test(main)) return { error: fieldError("mainUrl", t`Enter a stream URL starting with rtsp://`) };
  const sub = d.subUrl.trim();
  if (sub && !/^rtsps?:\/\/\S+$/i.test(sub)) return { error: fieldError("subUrl", t`The low-quality stream URL must start with rtsp://`) };
  const conn: CameraConnection = { type: "rtsp", mainUrl: main, transport: d.transport };
  if (sub) conn.subUrl = sub;
  if (d.onvifOn) {
    const port = Number(d.ovPort);
    if (!d.ovHost.trim()) return { error: fieldError("ovHost", t`Enter the ONVIF host`) };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: fieldError("ovPort", t`The ONVIF port must be a number from 1 to 65535`) };
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
  if (!d.name.trim()) return { error: fieldError("name", t`Give this camera a name`) };
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

const sameFields = (a: Draft, b: Draft, keys: FieldKey[]) => keys.every((k) => a[k] === b[k]);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 每個區塊怎麼算「有改」：連線比的是實際會送出的連線，Tapo 用不到的 RTSP 欄位不算 */
const SAME: Record<SectionKey, (a: Draft, b: Draft) => boolean> = {
  basic: (a, b) => sameFields(a, b, ["name", "enabled"]),
  conn: (a, b) => connKey(a) === connKey(b) && a.recDirect === b.recDirect && (a.type !== "rtsp" || sameFields(a, b, ["transport", "onvifOn"])),
  rec: (a, b) => sameFields(a, b, ["recEnabled", "recAudio"]),
  detect: (a, b) => sameJson(a.detect, b.detect),
  ptz: (a, b) => sameJson(a.ptz, b.ptz),
};

export const sectionChanged = (key: SectionKey, d: Draft, start: Draft) => !SAME[key](d, start);

/** base 換上 edited 裡這個區塊的欄位，其他區塊維持 base */
export function withSection(base: Draft, edited: Draft, key: SectionKey): Draft {
  const out = { ...base };
  for (const f of SECTION_FIELDS[key]) (out as Record<keyof Draft, unknown>)[f] = edited[f];
  return out;
}

/**
 * 編輯頁一次只開一個區塊：打開時從目前的設定複製一份 draft，start 留著比對有沒有改。
 * status 是送出的進度；error 顯示在對話框裡。
 */
export interface SectionEdit {
  key: SectionKey;
  /** 關閉後仍留著內容，讓對話框的關閉動畫有東西可畫；下次打開時整份換掉 */
  open: boolean;
  start: Draft;
  draft: Draft;
  status: "editing" | "testing" | "saving";
  error: FormError | null;
}

export type EditAction =
  | { type: "open"; key: SectionKey; from: Draft }
  | { type: "patch"; patch: Partial<Draft> }
  | { type: "submit"; status: "testing" | "saving" }
  | { type: "fail"; error: FormError }
  | { type: "close" };

export function editReducer(s: SectionEdit | null, a: EditAction): SectionEdit | null {
  if (a.type === "open") return { key: a.key, open: true, start: a.from, draft: a.from, status: "editing", error: null };
  if (!s) return null;
  switch (a.type) {
    case "patch":
      return { ...s, draft: { ...s.draft, ...a.patch }, error: clearsError(s.error, a.patch) ? null : s.error };
    case "submit":
      return { ...s, status: a.status, error: null };
    case "fail":
      return { ...s, status: "editing", error: a.error };
    case "close":
      return { ...s, open: false };
  }
}

/**
 * 儲存一個區塊：把它的欄位換進「現在」的設定（不是打開對話框時的那份，期間別處改的不會被蓋掉）再檢查。
 * test 是連線改過、存檔前要先測的連線；沒改連線時是 null。
 */
export function planSave(edit: SectionEdit, current: CameraConfig, homekit: CameraConfig["homekit"]): { config: CameraConfig; test: CameraConnection | null } | { error: FormError } {
  const base = draftOf(current);
  const merged = withSection(base, edit.draft, edit.key);
  const r = validate(merged, current, homekit);
  if ("error" in r) return r;
  return { config: r.config, test: edit.key === "conn" && connKey(merged) !== connKey(base) ? r.conn : null };
}

/** 網址裡的主機名稱，不含帳密與路徑 */
export function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^rtsps?:/i, "http:")).hostname;
  } catch {
    return "";
  }
}

const sensLabel = (level: "low" | "medium" | "high" | "custom") => {
  if (level === "low") return t`Low`;
  if (level === "medium") return t`Medium`;
  if (level === "high") return t`High`;
  return t`Custom`;
};

export const basicSummary = (d: Draft, existing: boolean) => `${d.name.trim() || t`Unnamed`}${existing ? ` · ${d.enabled ? t`Enabled` : t`Disabled`}` : ""}`;

export function connSummary(d: Draft): string {
  const host = d.type === "tapo" ? d.tapoHost.trim() : hostOf(d.mainUrl);
  return `${d.type === "tapo" ? "Tapo" : t`Other camera`} · ${host || t`No address yet`}${d.type === "rtsp" && d.onvifOn ? ` · ${t`Uses ONVIF`}` : ""}`;
}

export const connAdvancedSummary = (d: Draft) =>
  [d.type === "rtsp" ? d.transport.toUpperCase() : null, d.type === "rtsp" && d.onvifOn ? t`Uses ONVIF` : null, d.recDirect ? t`Records straight from the camera` : null].filter(Boolean).join(" · ") || t`Most setups need no changes`;

/** 連線的進階設定有不是預設值的東西時，一打開就展開 */
export const connAdvancedOpen = (d: Draft) => (d.type === "rtsp" && (d.transport !== "tcp" || d.onvifOn)) || d.recDirect;

export const recSummary = (d: Draft) => (!d.recEnabled ? t`Not recording` : d.recAudio ? t`Recording 24/7 · with sound` : t`Recording 24/7 · without sound`);

/** objects 是物件辨識的一句話（系統沒開物件辨識時是 null） */
export function detectSummary(d: DetectConfig, objects: string | null): string {
  if (!d.enabled) return t`Off`;
  const parts = [t`On`];
  if (d.source === "onvif") parts.push(t`Camera detection`);
  else {
    if (d.source === "both") parts.push(t`Motion + camera detection`);
    const level = sensLabel(sensitivityOf(d.threshold));
    parts.push(t`Sensitivity: ${level}`);
    const masks = d.masks.length;
    if (masks) parts.push(plural(masks, { one: "# excluded area", other: "# excluded areas" }));
  }
  if (objects) parts.push(objects);
  return parts.join(" · ");
}

export function describeConn(conn: CameraConnection): string {
  if (conn.type === "tapo") {
    const host = conn.host;
    return t`Tapo, host ${host}`;
  }
  const host = hostOf(conn.mainUrl);
  const transport = conn.transport.toUpperCase();
  const extras = [conn.subUrl ? t`has low-quality stream` : null, conn.onvif ? t`has ONVIF` : null].filter(Boolean);
  return t`RTSP, host ${host}, transport ${transport}` + (extras.length ? `, ${extras.join(", ")}` : "");
}

function copyText(conn: CameraConnection, error: string, detail?: string): string {
  const camera = describeConn(conn);
  const lines = [t`CookieNVR camera connection test failed`, t`Camera: ${camera}`, t`Error: ${error}`];
  if (detail) lines.push(t`ffprobe output:`, detail);
  lines.push(t`(Username and password omitted)`);
  return lines.join("\n");
}

/** 測試連線失敗：錯誤掛在對應的欄位，原文只放進「複製錯誤內容」 */
export function probeFailure(conn: CameraConnection, error: string, detail?: string): FormError {
  const tapo = conn.type === "tapo";
  const help = explainProbe(error, conn.type);
  const target: Record<NonNullable<ProbeField>, [FieldKey, FieldKey[]]> = {
    host: [tapo ? "tapoHost" : "mainUrl", []],
    url: [tapo ? "tapoHost" : "mainUrl", []],
    credentials: tapo ? ["tapoPass", ["tapoUser"]] : ["mainUrl", []],
    subUrl: ["subUrl", []],
  };
  return {
    summary: help.field ? t`Couldn't reach this camera, so nothing was saved` : help.message,
    field: help.field ? { key: target[help.field][0], message: help.message, also: target[help.field][1] } : undefined,
    card: "conn",
    copy: copyText(conn, error, detail),
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
  return [q ? `${q}（${s.width}×${s.height}）` : `${s.width}×${s.height}`, `${Math.round(s.fps * 10) / 10} fps`, s.videoCodec.toUpperCase().replace("HEVC", "H.265").replace("H264", "H.264"), s.audioCodec ? t`Has sound` : t`No sound`].join("・");
}
