/**
 * 給使用者看的伺服器訊息：API 回穩定的 code 加 params，前端（web/server-text.ts）依 code 換成目前語言。
 * 這裡的中文是後備文字：錯誤回應的 `error`、DTO 裡原本的字串欄位、日誌與診斷資訊都用它。
 * 每一區的訊息放在自己的檔案；前端在 web/server-messages/ 有同名的對照，型別保證每個 code 都有翻譯。
 */
import { camera } from "./camera.ts";
import { detection } from "./detection.ts";
import { requests } from "./requests.ts";
import { states } from "./states.ts";

/** params 的值：清單（例如裝置名稱）由前端依語言串接 */
export type MsgParam = string | number | string[];

const core = {
  /** 沒有對應 code 的文字（例如 ffmpeg 原文、舊資料），各語言都原樣顯示 */
  raw: ({ text }: { text: string }) => text,
  internal: () => "伺服器內部錯誤",
} satisfies MsgTable;

export type MsgTable = Record<string, (params: any) => string>;

export const ZH = { ...core, ...requests, ...camera, ...detection, ...states };

export type MsgCatalog = typeof ZH;
export type MsgCode = keyof MsgCatalog;
export type MsgParams<C extends MsgCode> = Parameters<MsgCatalog[C]> extends [infer P] ? P : undefined;

export type Msg = {
  [C in MsgCode]: MsgParams<C> extends undefined ? { code: C; params?: undefined } : { code: C; params: MsgParams<C> };
}[MsgCode];

export function msg<C extends MsgCode>(code: C, ...params: MsgParams<C> extends undefined ? [] : [MsgParams<C>]): Msg {
  return (params.length ? { code, params: params[0] } : { code }) as Msg;
}

/** 訊息的中文 */
export function zh(m: Msg): string {
  return (ZH[m.code] as (p: unknown) => string)(m.params);
}

/** 外部來源（detector 回報、舊資料）帶來的 code 不一定認得；認不得就當成原文 */
export function isMsgCode(code: unknown): code is MsgCode {
  return typeof code === "string" && Object.hasOwn(ZH, code);
}
