import { msg } from "../messages/index.ts";
import { HttpError } from "./errors.ts";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, msg("http.invalidJson"));
  }
}

/** 沒給 path 代表整個請求內容；有 path 代表其中的某個欄位 */
export function asObject(value: unknown, path?: string): JsonObject {
  if (!isObject(value)) throw new HttpError(400, path === undefined ? msg("http.bodyNotObject") : msg("field.notObject", { path }));
  return value;
}

export function str(
  obj: JsonObject,
  key: string,
  opts: { path?: string; max?: number; allowEmpty?: boolean } = {},
): string {
  const path = opts.path ?? key;
  const v = obj[key];
  if (typeof v !== "string") throw new HttpError(400, msg("field.notString", { path }));
  if (!opts.allowEmpty && v.trim() === "") throw new HttpError(400, msg("field.empty", { path }));
  if (v.length > (opts.max ?? 1024)) throw new HttpError(400, msg("field.tooLong", { path }));
  return v;
}

export function optStr(obj: JsonObject, key: string, opts: { path?: string; max?: number } = {}): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return undefined;
  return str(obj, key, opts);
}

export function bool(obj: JsonObject, key: string, path = key): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new HttpError(400, msg("field.notBool", { path }));
  return v;
}

export function int(obj: JsonObject, key: string, min: number, max: number, path = key): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, msg("field.intRange", { path, min, max }));
  }
  return v;
}

export function oneOf<T extends string>(obj: JsonObject, key: string, values: readonly T[], path = key): T {
  const v = obj[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new HttpError(400, msg("field.oneOf", { path, values: [...values] }));
  }
  return v as T;
}

export function parseIdParam(raw: string | undefined): number | null {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}
