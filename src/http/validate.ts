import { HttpError } from "./errors.ts";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "請求內容不是有效的 JSON");
  }
}

export function asObject(value: unknown, label = "請求內容"): JsonObject {
  if (!isObject(value)) throw new HttpError(400, `${label}必須是物件`);
  return value;
}

const bad = (path: string, what: string) => new HttpError(400, `欄位 ${path} ${what}`);

export function str(
  obj: JsonObject,
  key: string,
  opts: { path?: string; max?: number; allowEmpty?: boolean } = {},
): string {
  const path = opts.path ?? key;
  const v = obj[key];
  if (typeof v !== "string") throw bad(path, "必須是字串");
  if (!opts.allowEmpty && v.trim() === "") throw bad(path, "不能為空");
  if (v.length > (opts.max ?? 1024)) throw bad(path, "太長");
  return v;
}

export function optStr(obj: JsonObject, key: string, opts: { path?: string; max?: number } = {}): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return undefined;
  return str(obj, key, opts);
}

export function bool(obj: JsonObject, key: string, path = key): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw bad(path, "必須是布林值");
  return v;
}

export function int(obj: JsonObject, key: string, min: number, max: number, path = key): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw bad(path, `必須是 ${min} 到 ${max} 的整數`);
  }
  return v;
}

export function oneOf<T extends string>(obj: JsonObject, key: string, values: readonly T[], path = key): T {
  const v = obj[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw bad(path, `必須是 ${values.join(" 或 ")}`);
  }
  return v as T;
}

export function parseIdParam(raw: string | undefined): number | null {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}
