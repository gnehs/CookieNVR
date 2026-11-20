import type { OnvifError } from "../onvif/errors.ts";
import { isOnvifError } from "../onvif/errors.ts";
import { HttpError } from "../http/errors.ts";
import { msg, type Msg } from "../messages/index.ts";

/**
 * 給一般人看的說明，不含相機回傳的英文原文與帳密。
 * 驗證失敗不能用 401：前端遇到 401 會當成網站登入失效而登出。
 */
export function describeOnvifError(err: OnvifError): { status: number; msg: Msg } {
  switch (err.kind) {
    case "unreachable":
      return { status: 503, msg: msg("ptz.onvifUnreachable") };
    case "timeout":
      return { status: 504, msg: msg("ptz.onvifTimeout") };
    case "auth":
      return { status: 502, msg: msg("ptz.onvifAuth") };
    case "fault":
      return { status: 502, msg: msg("ptz.onvifFault") };
    case "aborted":
    case "protocol":
      return { status: 502, msg: msg("ptz.onvifProtocol") };
  }
}

/** ONVIF 的錯誤轉成 HttpError；其他錯誤原樣丟出，讓路由層記成 500 */
export function toHttpError(err: unknown): unknown {
  if (!isOnvifError(err)) return err;
  const { status, msg } = describeOnvifError(err);
  return new HttpError(status, msg);
}
