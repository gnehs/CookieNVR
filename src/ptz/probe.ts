import type { OnvifProbeDto } from "../api-types.ts";
import { isOnvifError, OnvifClient, OnvifError } from "../onvif/index.ts";
import type { CameraConnection } from "../types.ts";
import { onvifEndpointOf } from "./config.ts";
import { describeOnvifError } from "./errors.ts";

export interface OnvifProbeOptions {
  fetch?: typeof fetch;
  /** 整個探測的時間上限 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** 測試連線時順便看 ONVIF 與 PTZ。永不丟錯：連不上只是 unavailable，不影響串流測試的結果。 */
export async function probeOnvif(conn: CameraConnection, opts: OnvifProbeOptions = {}): Promise<OnvifProbeDto> {
  const endpoint = onvifEndpointOf(conn);
  if (!endpoint) return { state: "unconfigured" };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new OnvifClient(endpoint, { fetch: opts.fetch, timeoutMs });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OnvifError("timeout", "探測逾時", "probe")), timeoutMs);
  });
  try {
    const caps = await Promise.race([client.capabilities(), deadline]);
    return {
      state: "available",
      ptz: caps.ptz !== null,
      zoom: caps.ptz?.zoom ?? false,
      maxPresets: caps.ptz?.maxPresets ?? null,
    };
  } catch (err) {
    const e = isOnvifError(err) ? err : new OnvifError("protocol", "探測失敗", "probe");
    return { state: "unavailable", kind: e.kind, message: describeOnvifError(e).message };
  } finally {
    clearTimeout(timer);
  }
}
