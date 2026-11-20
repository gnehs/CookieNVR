import { isMsgCode, msg, type Msg } from "./index.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 外部來源（detector、worker 的 IPC、存檔）給的 code 與 params；code 不認得就把原文當 raw */
export function externalMsg(code: unknown, params: unknown, text: string): Msg {
  if (!isMsgCode(code)) return msg("raw", { text });
  return (isObj(params) ? { code, params } : { code }) as Msg;
}

/** 外部來源給的 `{ code, params }` 物件 */
export function msgOrRaw(m: unknown, text: string): Msg {
  return isObj(m) ? externalMsg(m.code, m.params, text) : msg("raw", { text });
}
