import { zh, type Msg } from "../messages/index.ts";

/** message 是中文（日誌用）；回應帶 msg 的 code 與 params，前端依語言顯示 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly msg: Msg,
    readonly headers?: Record<string, string>,
  ) {
    super(zh(msg));
  }
}
