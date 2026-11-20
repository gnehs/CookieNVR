import type { CropBox, FrigateConfigResultDto, StateSensorConfig } from "../api-types.ts";
import { HttpError } from "../http/errors.ts";
import { isObject, type JsonObject } from "../http/validate.ts";
import { msg, type Msg } from "../messages/index.ts";

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_INTERVAL_SEC = 10;
const MAX_CLASSES = 10;

const bad = (m: Msg) => new HttpError(400, m);

/** 類別名稱同時是資料夾外的標記值與 zip 裡的資料夾名：不可含路徑字元，不可以 . 開頭 */
export function parseClassName(v: unknown, renamed = false): string {
  if (typeof v !== "string") throw bad(msg("states.classNameNotString", { renamed }));
  const s = v.trim();
  if (s.length < 1 || s.length > 32) throw bad(msg("states.classNameLength", { renamed }));
  if (/[/\\]/.test(s) || s.startsWith(".")) throw bad(msg("states.classNameChars", { renamed }));
  return s;
}

export function parseCrop(v: unknown): CropBox {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) {
    throw bad(msg("states.cropInvalid"));
  }
  const [x1, y1, x2, y2] = v as CropBox;
  if (x2 - x1 < 0.01 || y2 - y1 < 0.01) throw bad(msg("states.cropTooSmall"));
  return [x1, y1, x2, y2];
}

function number(obj: JsonObject, key: string, min: number, max: number, fallback: number, bound: "threshold" | "intervalSec"): number {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (bound === "intervalSec" && !Number.isInteger(v))) {
    throw bad(msg(bound === "threshold" ? "states.thresholdRange" : "states.intervalRange", { min, max }));
  }
  return v;
}

function flag(obj: JsonObject, key: string, fallback: boolean): boolean {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw bad(msg("states.flagNotBool", { field: key }));
  return v;
}

/** POST／PUT 的 config：name、classes、crop 必填，其餘省略時取 base（PUT 時是原本的設定）或預設值 */
export function parseSensorConfig(v: unknown, base?: StateSensorConfig): StateSensorConfig {
  if (!isObject(v)) throw bad(msg("states.configNotObject"));
  if (typeof v.name !== "string" || v.name.trim().length < 1 || v.name.trim().length > 40) throw bad(msg("states.nameLength"));
  if (!Array.isArray(v.classes) || v.classes.length < 2 || v.classes.length > MAX_CLASSES) throw bad(msg("states.classCount", { min: 2, max: MAX_CLASSES }));
  const classes = v.classes.map((c) => parseClassName(c));
  if (new Set(classes).size !== classes.length) throw bad(msg("states.classDuplicate"));
  return {
    name: v.name.trim(),
    classes,
    crop: parseCrop(v.crop),
    threshold: number(v, "threshold", 0.5, 0.99, base?.threshold ?? DEFAULT_THRESHOLD, "threshold"),
    intervalSec: number(v, "intervalSec", 0, 3600, base?.intervalSec ?? DEFAULT_INTERVAL_SEC, "intervalSec"),
    onMotion: flag(v, "onMotion", base?.onMotion ?? true),
    enabled: flag(v, "enabled", base?.enabled ?? true),
  };
}

/** 資料庫裡的設定：自己寫進去的，只補上之後新增欄位的預設值 */
export function storedConfig(text: string): StateSensorConfig {
  const v = JSON.parse(text) as Partial<StateSensorConfig>;
  return {
    name: v.name ?? "",
    classes: v.classes ?? [],
    crop: v.crop ?? [0, 0, 1, 1],
    threshold: v.threshold ?? DEFAULT_THRESHOLD,
    intervalSec: v.intervalSec ?? DEFAULT_INTERVAL_SEC,
    onMotion: v.onMotion ?? true,
    enabled: v.enabled ?? true,
  };
}

/**
 * Frigate 設定檔片段 → 感應器設定。接受完整設定、從 `classification:`、`custom:` 或 `<模型名稱>:` 開始的片段。
 * 只讀 threshold 與 state_config 的 motion、interval、cameras.<攝影機>.crop（Frigate 的 motion 預設 false，interval 預設不定時）。
 */
export function parseFrigateConfig(yaml: string): FrigateConfigResultDto {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(yaml);
  } catch (e) {
    throw bad(msg("states.yamlParseFailed", { detail: e instanceof Error ? e.message : String(e) }));
  }
  const models = findModels(doc);
  const sensors: FrigateConfigResultDto["sensors"] = [];
  for (const [name, model] of models) {
    const state = model.state_config;
    if (!isObject(state) || !isObject(state.cameras)) continue;
    const threshold = typeof model.threshold === "number" ? Math.min(0.99, Math.max(0.5, model.threshold)) : DEFAULT_THRESHOLD;
    const interval = typeof state.interval === "number" && state.interval > 0 ? Math.min(3600, Math.round(state.interval)) : 0;
    for (const [camera, cam] of Object.entries(state.cameras)) {
      if (!isObject(cam)) continue;
      let crop: CropBox;
      try {
        crop = parseCrop(cam.crop);
      } catch {
        continue;
      }
      sensors.push({ name, camera, crop, threshold, intervalSec: interval, onMotion: state.motion === true });
    }
  }
  if (sensors.length === 0) throw bad(msg("states.frigateConfigNotFound"));
  return { sensors };
}

function findModels(doc: unknown): [string, JsonObject][] {
  if (!isObject(doc)) return [];
  const custom = isObject(doc.classification) && isObject(doc.classification.custom) ? doc.classification.custom : isObject(doc.custom) ? doc.custom : doc;
  return Object.entries(custom).filter((e): e is [string, JsonObject] => isObject(e[1]) && isObject(e[1].state_config));
}
