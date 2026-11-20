import type { PtzCommandDto, PtzRemovePresetDto, PtzSavePresetDto } from "../api-types.ts";
import { HttpError } from "../http/errors.ts";
import { asObject, oneOf, str, type JsonObject } from "../http/validate.ts";
import { msg } from "../messages/index.ts";
import { MAX_SPEED, MIN_SPEED } from "../onvif/index.ts";
import type { PtzMode } from "../types.ts";

export const PTZ_MODES = ["auto", "continuous", "relative"] as const satisfies readonly PtzMode[];
const MAX_PRESET_NAME = 64;

function num(obj: JsonObject, key: string, min: number, max: number, fallback?: number): number {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, msg("ptz.numberRange", { key, min, max }));
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new HttpError(400, msg("ptz.numberRange", { key, min, max }));
  }
  return v;
}

/** 回傳 undefined 表示請求沒帶，用攝影機的偏好 */
export function optSpeed(obj: JsonObject): number | undefined {
  return obj.speed === undefined || obj.speed === null ? undefined : num(obj, "speed", MIN_SPEED, MAX_SPEED);
}

export type ParsedPtzCommand =
  | { action: "move"; pan: number; tilt: number; zoom: number; speed?: number; mode?: PtzMode }
  | { action: "stop" }
  | { action: "preset"; token: string; speed?: number };

export function parsePtzCommand(value: unknown): ParsedPtzCommand {
  const o = asObject(value);
  const action = oneOf(o, "action", ["move", "stop", "preset"] as const satisfies readonly PtzCommandDto["action"][]);
  if (action === "stop") return { action };
  if (action === "preset") return { action, token: str(o, "token", { max: 128 }), speed: optSpeed(o) };
  const pan = num(o, "pan", -1, 1, 0);
  const tilt = num(o, "tilt", -1, 1, 0);
  const zoom = num(o, "zoom", -1, 1, 0);
  if (pan === 0 && tilt === 0 && zoom === 0) throw new HttpError(400, msg("ptz.noDirection"));
  const move: ParsedPtzCommand = { action, pan, tilt, zoom, speed: optSpeed(o) };
  if (o.mode !== undefined && o.mode !== null) move.mode = oneOf(o, "mode", PTZ_MODES);
  return move;
}

export function parseSavePreset(value: unknown): PtzSavePresetDto {
  const o = asObject(value);
  const name = str(o, "name", { max: MAX_PRESET_NAME }).trim();
  if (name === "") throw new HttpError(400, msg("ptz.nameEmpty"));
  if (o.token === undefined || o.token === null) return { name };
  return { name, token: str(o, "token", { max: 128 }) };
}

export function parseRemovePreset(value: unknown): PtzRemovePresetDto {
  return { token: str(asObject(value), "token", { max: 128 }) };
}
