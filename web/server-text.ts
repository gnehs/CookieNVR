import { t } from "@lingui/core/macro";
import type { Msg, MsgCatalog } from "../src/messages/index.ts";
import { camera } from "./server-messages/camera.ts";
import { detection } from "./server-messages/detection.ts";
import { requests } from "./server-messages/requests.ts";
import { states } from "./server-messages/states.ts";

/** 每個伺服器訊息 code 的翻譯；參數型別和 src/messages/ 的中文版相同 */
export type Translations<T> = { [K in keyof T]: T[K] extends (...args: infer A) => string ? (...args: A) => string : never };

const TEXT: Translations<MsgCatalog> = {
  raw: ({ text }) => text,
  internal: () => t`Internal server error`,
  ...requests,
  ...camera,
  ...detection,
  ...states,
};

/**
 * 伺服器訊息換成目前語言。沒有 msg（舊版伺服器）或不認得的 code（比前端新的伺服器）時用 fallback，
 * 也就是伺服器給的中文。
 */
export function serverText(m: Msg | null | undefined, fallback = ""): string {
  if (!m || !Object.hasOwn(TEXT, m.code)) return fallback;
  return (TEXT[m.code] as (p: unknown) => string)(m.params);
}
