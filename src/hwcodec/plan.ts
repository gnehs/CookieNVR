import { msg, type Msg } from "../messages/index.ts";
import type { HwParams } from "../messages/detection.ts";
import type { DeviceRef } from "../types.ts";
import { CODEC_LABEL, hwFailure, type CodecName, type HwApi, type HwFailure } from "./commands.ts";
import type { ProbedDevice } from "./probe.ts";

/** detect worker 用哪張卡解碼；worker 由環境變數收到這份，啟動失敗時自己退回 CPU */
export interface HwDecode {
  deviceId: DeviceRef;
  name: string;
  /** 規劃時認定的編碼格式，只用在錯誤訊息 */
  codec: CodecName;
  api: HwApi;
}

/**
 * hw = null 就是 CPU。note 是「沒照使用者選的做」的原因：選的卡不見了、不支援這個格式、試跑失敗。
 * 自動模式在沒有任何顯示卡時用 CPU 是正常結果，沒有 note。
 */
export interface DecodePlan {
  hw: HwDecode | null;
  note: HwFailure | null;
}

/** 自動模式的順序和物件辨識相同：Nvidia、Intel，最後才是開發機的 VideoToolbox */
const AUTO_ORDER = ["nvidia", "intel", "apple"] as const;

const use = (d: ProbedDevice, codec: CodecName, note: HwFailure | null = null): DecodePlan => ({ hw: { deviceId: d.id, name: d.name, codec, api: d.api }, note });
const CPU: DecodePlan = { hw: null, note: null };

/** 原因（hw.* 訊息）再補上顯示卡名稱或影像格式 */
const extend = (m: Msg, extra: HwParams): Msg => ({ ...m, params: { ...(m.params as HwParams | undefined), ...extra } }) as Msg;

/**
 * @param devices 試跑結果；null 表示還沒跑完，先用 CPU（跑完後 worker 規格改變，自動重啟）
 * @param codec 這台 detect 碼流的影像格式；還不知道時當作 H.264（最常見），真的不支援時 worker 會自己退回
 */
export function planDecode(requested: DeviceRef, devices: ProbedDevice[] | null, codec: CodecName | null): DecodePlan {
  if (requested === "cpu" || devices === null) return CPU;
  const c = codec ?? "h264";
  const auto = (note: HwFailure | null): DecodePlan => {
    const ordered = AUTO_ORDER.flatMap((k) => devices.filter((d) => d.kind === k));
    const ok = ordered.find((d) => d.decode[c].ok);
    if (ok) return use(ok, c, note);
    if (note) return { hw: null, note };
    // 有卡但每張都不能用：使用者大概以為有在用顯示卡，說明原因
    const first = ordered[0];
    const check = first?.decode[c];
    return check && !check.ok ? { hw: null, note: hwFailure(extend(check.reasonMsg, { device: first.name }), check.detail) } : CPU;
  };
  if (requested === "auto") return auto(null);
  const chosen = devices.find((d) => d.id === requested);
  if (!chosen) return auto(hwFailure(msg("hw.deviceGone", {}), `requested ${requested}; found ${devices.map((d) => d.id).join(", ") || "none"}`));
  const check = chosen.decode[c];
  if (check.ok) return use(chosen, c);
  return { hw: null, note: hwFailure(check.reason.includes(CODEC_LABEL[c]) ? check.reasonMsg : extend(check.reasonMsg, { forCodec: CODEC_LABEL[c] }), check.detail) };
}
