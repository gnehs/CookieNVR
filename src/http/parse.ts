import { DEFAULT_DETECT, LIMITS } from "../detect/config.ts";
import { LABEL_KEY } from "../objects/labels.ts";
import { MAX_SPEED, MIN_SPEED } from "../onvif/index.ts";
import { OBJECT_FPS_CHOICES, type CameraConfig, type CameraConnection, type DetectConfig, type DeviceTask, type MaskPolygon, type ObjectSettings, type OnvifEndpoint, type PtzPrefs, type Settings } from "../types.ts";
import { HttpError } from "./errors.ts";
import { asObject, bool, int, isObject, oneOf, optStr, str, type JsonObject } from "./validate.ts";
import { msg } from "../messages/index.ts";

function rtspUrl(obj: JsonObject, key: string, path: string): string {
  const value = str(obj, key, { path, max: 2048 }).trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, msg("field.invalidUrl", { path }));
  }
  if ((url.protocol !== "rtsp:" && url.protocol !== "rtsps:") || url.hostname === "") {
    throw new HttpError(400, msg("field.rtspUrl", { path }));
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
    if (/[\s/@]/.test(host)) throw new HttpError(400, msg("field.invalidHost", { path: `${base}.host` }));
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
    throw new HttpError(400, msg("field.numberRange", { path: "ptz.speed", min: MIN_SPEED, max: MAX_SPEED }));
  }
  const flag = (key: "invertPan" | "invertTilt") => {
    const v = o[key];
    if (v === undefined) return false;
    if (typeof v !== "boolean") throw new HttpError(400, msg("field.boolLiteral", { path: `ptz.${key}` }));
    return v;
  };
  return { mode: oneOf(o, "mode", PTZ_MODES, "ptz.mode"), speed, invertPan: flag("invertPan"), invertTilt: flag("invertTilt") };
}

function num(o: JsonObject, key: string, min: number, max: number, path: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, msg("field.numberRange", { path, min, max }));
  return v;
}

function parseMask(value: unknown, path: string): MaskPolygon {
  const o = asObject(value, path);
  const pts = o.points;
  if (!Array.isArray(pts) || pts.length < LIMITS.points.min || pts.length > LIMITS.points.max) {
    throw new HttpError(400, msg("field.pointCount", { path: `${path}.points`, min: LIMITS.points.min, max: LIMITS.points.max }));
  }
  const points = pts.map((p, i): [number, number] => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw new HttpError(400, msg("field.pointRange", { path: `${path}.points[${i}]` }));
    }
    return [p[0], p[1]];
  });
  return { points };
}

const DETECT_SOURCES = ["pixel", "onvif", "both"] as const;
const OBJECT_MODES = ["off", "annotate", "filter"] as const;

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 40 || !value.every((v): v is string => typeof v === "string" && LABEL_KEY.test(v))) {
    throw new HttpError(400, msg("field.labels"));
  }
  return [...new Set(value)];
}

function parseDetect(value: unknown): DetectConfig {
  const o = asObject(value, "detect");
  const masks = o.masks;
  if (!Array.isArray(masks) || masks.length > LIMITS.masks) throw new HttpError(400, msg("field.maxPolygons", { path: "detect.masks", max: LIMITS.masks }));
  const objectMasks = o.objectMasks ?? [];
  if (!Array.isArray(objectMasks) || objectMasks.length > LIMITS.masks) throw new HttpError(400, msg("field.maxPolygons", { path: "detect.objectMasks", max: LIMITS.masks }));
  return {
    enabled: bool(o, "enabled", "detect.enabled"),
    source: oneOf(o, "source", DETECT_SOURCES, "detect.source"),
    threshold: int(o, "threshold", LIMITS.threshold.min, LIMITS.threshold.max, "detect.threshold"),
    minArea: num(o, "minArea", LIMITS.minArea.min, LIMITS.minArea.max, "detect.minArea"),
    cooldownSec: int(o, "cooldownSec", LIMITS.cooldownSec.min, LIMITS.cooldownSec.max, "detect.cooldownSec"),
    masks: masks.map((m, i) => parseMask(m, `detect.masks[${i}]`)),
    // 物件專用的排除區域是後來才加的，舊的用戶端送來的設定沒有
    objectMasks: objectMasks.map((m, i) => parseMask(m, `detect.objectMasks[${i}]`)),
    // 物件辨識的欄位是 M4 才加的，舊的用戶端（例如 HA 整合）送來的設定可能沒有
    labels: o.labels === undefined ? DEFAULT_DETECT.labels : parseLabels(o.labels),
    objectMode: o.objectMode === undefined ? DEFAULT_DETECT.objectMode : oneOf(o, "objectMode", OBJECT_MODES, "detect.objectMode"),
    objectScore: o.objectScore === undefined ? DEFAULT_DETECT.objectScore : num(o, "objectScore", LIMITS.objectScore.min, LIMITS.objectScore.max, "detect.objectScore"),
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
  if (o.homekit !== undefined && o.homekit !== null) {
    config.homekit = { enabled: bool(asObject(o.homekit, "homekit"), "enabled", "homekit.enabled") };
  }
  return config;
}

const SETTINGS_KEYS = ["siteName", "storagePath", "retention", "rtsp", "homekit", "objects", "devices"];
/** auto、cpu，或偵測到的識別字（intel:GPU.0、nvidia:GPU-<uuid>、nvidia:0；apple:0 只出現在 macOS 開發機） */
const DEVICE_REF = /^(auto|cpu|intel:[A-Za-z0-9._-]{1,40}|nvidia:[A-Za-z0-9._-]{1,80}|apple:\d{1,2})$/;
const DEVICE_TASKS: DeviceTask[] = ["objects", "decode"];
/** 使用者模型是 <dataDir>/models/ 底下的檔名，不能帶路徑 */
const MODEL_FILE = /^[\w.\- ]{1,120}\.onnx$/;

function rejectUnknown(o: JsonObject, allowed: string[], base: string) {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) throw new HttpError(400, msg("field.notSettable", { path: `${base ? `${base}.` : ""}${key}` }));
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
    if (!p.startsWith("/")) throw new HttpError(400, msg("field.absolutePath", { path: "storagePath" }));
    patch.storagePath = p;
  }
  if (o.retention !== undefined) {
    if (!isObject(o.retention)) throw new HttpError(400, msg("field.notObject", { path: "retention" }));
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
    if (!isObject(o.rtsp)) throw new HttpError(400, msg("field.notObject", { path: "rtsp" }));
    rejectUnknown(o.rtsp, ["externalEnabled"], "rtsp");
    patch.rtsp = { externalEnabled: bool({ ...current.rtsp, ...o.rtsp }, "externalEnabled", "rtsp.externalEnabled") };
  }
  if (o.homekit !== undefined) {
    if (!isObject(o.homekit)) throw new HttpError(400, msg("field.notObject", { path: "homekit" }));
    rejectUnknown(o.homekit, ["enabled", "basePort"], "homekit");
    const merged = { ...current.homekit, ...o.homekit };
    patch.homekit = { enabled: bool(merged, "enabled", "homekit.enabled"), basePort: int(merged, "basePort", 1024, 65000, "homekit.basePort") };
  }
  if (o.objects !== undefined) {
    if (!isObject(o.objects)) throw new HttpError(400, msg("field.notObject", { path: "objects" }));
    rejectUnknown(o.objects, ["enabled", "model", "fps"], "objects");
    const merged = { ...current.objects, ...o.objects };
    const model = str(merged, "model", { path: "objects.model", max: 128 });
    if (model !== "builtin" && (!MODEL_FILE.test(model) || model.startsWith("."))) throw new HttpError(400, msg("field.modelFile"));
    if (!(OBJECT_FPS_CHOICES as readonly unknown[]).includes(merged.fps)) throw new HttpError(400, msg("field.oneOfList", { path: "objects.fps", values: OBJECT_FPS_CHOICES.map(String) }));
    patch.objects = { enabled: bool(merged, "enabled", "objects.enabled"), model, fps: merged.fps as number } satisfies ObjectSettings;
  }
  if (o.devices !== undefined) {
    if (!isObject(o.devices)) throw new HttpError(400, msg("field.notObject", { path: "devices" }));
    rejectUnknown(o.devices, DEVICE_TASKS, "devices");
    const merged = { ...current.devices, ...o.devices };
    const ref = (task: DeviceTask) => {
      const v = str(merged, task, { path: `devices.${task}`, max: 100 });
      if (!DEVICE_REF.test(v)) throw new HttpError(400, msg("field.deviceRef", { path: `devices.${task}` }));
      return v;
    };
    patch.devices = { objects: ref("objects"), decode: ref("decode") };
  }
  return patch;
}
