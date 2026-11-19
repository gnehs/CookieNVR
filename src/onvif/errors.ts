export type OnvifErrorKind =
  /** 連不上主機（拒絕連線、DNS、網路中斷） */
  | "unreachable"
  /** 超過請求時間上限 */
  | "timeout"
  /** 呼叫端主動中止 */
  | "aborted"
  /** 帳密錯誤或驗證被拒 */
  | "auth"
  /** 相機回傳 SOAP Fault（驗證以外的錯誤） */
  | "fault"
  /** 回應不是可解讀的 SOAP，或缺少必要欄位 */
  | "protocol";

export interface SoapFaultDetail {
  /** 例如 `Sender`、`Receiver`，已去掉前綴 */
  code: string;
  /** 最內層的 Subcode，已去掉前綴，例如 `ActionNotSupported` */
  subcode: string | null;
  reason: string;
}

export class OnvifError extends Error {
  override name = "OnvifError";
  constructor(
    readonly kind: OnvifErrorKind,
    message: string,
    /** 發生錯誤的 SOAP 動作名稱，例如 `ContinuousMove` */
    readonly action: string,
    readonly fault: SoapFaultDetail | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

export function isOnvifError(err: unknown, kind?: OnvifErrorKind): err is OnvifError {
  return err instanceof OnvifError && (kind === undefined || err.kind === kind);
}
