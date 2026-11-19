import { LIMITS } from "../detect/config.ts";
import { MAX_SPEED, MIN_SPEED } from "../onvif/index.ts";
import type { CameraConfig, CameraConnection, DetectConfig, MaskPolygon, OnvifEndpoint, PtzPrefs, Settings } from "../types.ts";
import { HttpError } from "./errors.ts";
import { asObject, bool, int, isObject, oneOf, optStr, str, type JsonObject } from "./validate.ts";

function rtspUrl(obj: JsonObject, key: string, path: string): string {
  const value = str(obj, key, { path, max: 2048 }).trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `欄位 ${path} 不是有效的網址`);
  }
  if ((url.protocol !== "rtsp:" && url.protocol !== "rtsps:") || url.hostname === "") {
    throw new HttpError(400, `欄位 ${path} 必須是 rtsp:// 或 rtsps:// 網址`);
  }
  return value;
}

function parseOnvif(value: unknown, base: string): OnvifEndpoint {
  const o = asObject(value, base);
  return {
    host: str(o, "host", { path: `${base}.host`, max: 255 }).trim(),
    port: int(o, "port", 1, 65535, `${base}.port`),
    username: str(o, "username", { path: `${base}.username`, max: 256, allowEmpty: true }),
    password: str(o, "password", { path: `${base}.password`, max: 256, allowEmpty: true }),
  };
}

export function parseConnection(value: unknown, base = "connection"): CameraConnection {
  const o = asObject(value, base);
  const type = oneOf(o, "type", ["tapo", "rtsp"] as const, `${base}.type`);
  if (type === "tapo") {
    const host = str(o, "host", { path: `${base}.host`, max: 255 }).trim();
    if (/[\s/@]/.test(host)) throw new HttpError(400, `欄位 ${base}.host 不是有效的主機名稱`);
    return {
      type,
      host,
      username: str(o, "username", { path: `${base}.username`, max: 256 }),
      password: str(o, "password", { path: `${base}.password`, max: 256, allowEmpty: true }),
    };
  }
  const conn: Extract<CameraConnection, { type: "rtsp" }> = {
    type,
    mainUrl: rtspUrl(o, "mainUrl", `${base}.mainUrl`),
    transport: oneOf(o, "transport", ["tcp", "udp"] as const, `${base}.transport`),
  };
  if (optStr(o, "subUrl") !== undefined) conn.subUrl = rtspUrl(o, "subUrl", `${base}.subUrl`);
  if (o.onvif !== undefined && o.onvif !== null) conn.onvif = parseOnvif(o.onvif, `${base}.onvif`);
  return conn;
}

const PTZ_MODES = ["auto", "continuous", "relative"] as const;

function parsePtzPrefs(value: unknown): PtzPrefs {
  const o = asObject(value, "ptz");
  const speed = o.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new HttpError(400, `欄位 ptz.speed 必須是 ${MIN_SPEED} 到 ${MAX_SPEED} 的數字`);
  }
  return { mode: oneOf(o, "mode", PTZ_MODES, "ptz.mode"), speed };
}

function num(o: JsonObject, key: string, min: number, max: number, path: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `欄位 ${path} 必須是 ${min} 到 ${max} 的數字`);
  return v;
}

function parseMask(value: unknown, path: string): MaskPolygon {
  const o = asObject(value, path);
  const pts = o.points;
  if (!Array.isArray(pts) || pts.length < LIMITS.points.min || pts.length > LIMITS.points.max) {
    throw new HttpError(400, `欄位 ${path}.points 必須有 ${LIMITS.points.min} 到 ${LIMITS.points.max} 個頂點`);
  }
  const points = pts.map((p, i): [number, number] => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw new HttpError(400, `欄位 ${path}.points[${i}] 必須是兩個 0 到 1 的數字`);
    }
    return [p[0], p[1]];
  });
  return { points };
}

const DETECT_SOURCES = ["pixel", "onvif", "both"] as const;

function parseDetect(value: unknown): DetectConfig {
  const o = asObject(value, "detect");
  const masks = o.masks;
  if (!Array.isArray(masks) || masks.length > LIMITS.masks) throw new HttpError(400, `欄位 detect.masks 必須是最多 ${LIMITS.masks} 個多邊形的陣列`);
  return {
    enabled: bool(o, "enabled", "detect.enabled"),
    source: oneOf(o, "source", DETECT_SOURCES, "detect.source"),
    threshold: int(o, "threshold", LIMITS.threshold.min, LIMITS.threshold.max, "detect.threshold"),
    minArea: num(o, "minArea", LIMITS.minArea.min, LIMITS.minArea.max, "detect.minArea"),
    cooldownSec: int(o, "cooldownSec", LIMITS.cooldownSec.min, LIMITS.cooldownSec.max, "detect.cooldownSec"),
    masks: masks.map((m, i) => parseMask(m, `detect.masks[${i}]`)),
  };
}

export function parseCameraConfig(value: unknown): CameraConfig {
  const o = asObject(value);
  const name = str(o, "name", { max: 100 }).trim();
  const record = asObject(o.record, "record");
  const config: CameraConfig = {
    name,
    enabled: bool(o, "enabled"),
    connection: parseConnection(o.connection),
    record: {
      enabled: bool(record, "enabled", "record.enabled"),
      audio: bool(record, "audio", "record.audio"),
      direct: bool(record, "direct", "record.direct"),
    },
  };
  if (o.ptz !== undefined && o.ptz !== null) config.ptz = parsePtzPrefs(o.ptz);
  if (o.detect !== undefined && o.detect !== null) config.detect = parseDetect(o.detect);
  return config;
}

const SETTINGS_KEYS = ["siteName", "storagePath", "retention", "rtsp"];

function rejectUnknown(o: JsonObject, allowed: string[], base: string) {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) throw new HttpError(400, `${base ? `${base}.` : ""}${key} 不是可設定的欄位`);
  }
}

/** 巢狀欄位允許只送部分，缺的沿用 current，所以回傳的 retention／rtsp 一定完整。 */
export function parseSettingsPatch(value: unknown, current: Settings): Partial<Settings> {
  const o = asObject(value);
  rejectUnknown(o, SETTINGS_KEYS, "");
  const patch: Partial<Settings> = {};

  if (o.siteName !== undefined) patch.siteName = str(o, "siteName", { max: 100 }).trim();
  if (o.storagePath !== undefined) {
    const p = str(o, "storagePath", { max: 1024 }).trim();
    if (!p.startsWith("/")) throw new HttpError(400, "欄位 storagePath 必須是絕對路徑");
    patch.storagePath = p;
  }
  if (o.retention !== undefined) {
    if (!isObject(o.retention)) throw new HttpError(400, "欄位 retention 必須是物件");
    const r = o.retention;
    rejectUnknown(r, ["continuousDays", "eventDays", "minFreeBytes"], "retention");
    const merged = { ...current.retention, ...r };
    patch.retention = {
      continuousDays: int(merged, "continuousDays", 1, 3650, "retention.continuousDays"),
      eventDays: int(merged, "eventDays", 1, 3650, "retention.eventDays"),
      minFreeBytes: int(merged, "minFreeBytes", 0, Number.MAX_SAFE_INTEGER, "retention.minFreeBytes"),
    };
  }
  if (o.rtsp !== undefined) {
    if (!isObject(o.rtsp)) throw new HttpError(400, "欄位 rtsp 必須是物件");
    rejectUnknown(o.rtsp, ["externalEnabled"], "rtsp");
    patch.rtsp = { externalEnabled: bool({ ...current.rtsp, ...o.rtsp }, "externalEnabled", "rtsp.externalEnabled") };
  }
  return patch;
}
