import type { OnvifError } from "../onvif/errors.ts";
import { isOnvifError } from "../onvif/errors.ts";
import { HttpError } from "../http/errors.ts";

/**
 * 給一般人看的說明，不含相機回傳的英文原文與帳密。
 * 驗證失敗不能用 401：前端遇到 401 會當成網站登入失效而登出。
 */
export function describeOnvifError(err: OnvifError): { status: number; message: string } {
  switch (err.kind) {
    case "unreachable":
      return { status: 503, message: "連不上相機的控制連線，請確認相機已開機、與本機在同一個網路，且 ONVIF 位址與埠號正確" };
    case "timeout":
      return { status: 504, message: "相機沒有回應，請稍後再試" };
    case "auth":
      return { status: 502, message: "相機拒絕了帳號或密碼，請到設定確認相機帳戶" };
    case "fault":
      return { status: 502, message: "相機拒絕了這個指令，請稍後再試" };
    case "aborted":
    case "protocol":
      return { status: 502, message: "相機的回應無法辨識，這台可能不支援鏡頭控制" };
  }
}

/** ONVIF 的錯誤轉成 HttpError；其他錯誤原樣丟出，讓路由層記成 500 */
export function toHttpError(err: unknown): unknown {
  if (!isOnvifError(err)) return err;
  const { status, message } = describeOnvifError(err);
  return new HttpError(status, message);
}
