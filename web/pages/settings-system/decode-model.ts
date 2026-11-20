import { joinClauses } from "../../format.ts";
import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import type { CameraDecodeDto, DecodeStatusDto, InferenceDeviceDto, VideoDeviceDto } from "../../../src/api-types.ts";
import { indexedName, tidyName } from "../../detect/object-model.ts";
import { serverText } from "../../server-text.ts";

export interface DecodeOption {
  value: string;
  label: string;
  desc?: string;
  disabled?: boolean;
}

export const DECODE_AUTO = "auto";
export const DECODE_CPU = "cpu";

export const DECODE_HINT: MessageDescriptor = msg`Cameras with a sub-stream gain very little. The CPU savings only show when decoding the main stream directly or high-resolution H.265.`;

/** 顯示名稱：物件辨識那邊同 id 的型號優先（兩邊的選單才會長一樣），沒有才用試跑拿到的名稱 */
function nameOf(d: VideoDeviceDto, objectDevices: readonly InferenceDeviceDto[]): string {
  return tidyName(objectDevices.find((o) => o.id === d.id)?.name ?? d.name);
}

/** 這張卡的解碼限制：兩種都不行回傳原因（選項停用），只有一種不行回傳「不支援 H.265」，都可以回傳 null */
export function decodeLimit(d: VideoDeviceDto): { usable: boolean; note: string | null } {
  const { h264, hevc } = d.decode;
  if (!h264.ok && !hevc.ok) return { usable: false, note: serverText(h264.reasonMsg, h264.reason) };
  if (!h264.ok) return { usable: true, note: t`H.264 not supported` };
  if (!hevc.ok) return { usable: true, note: t`H.265 not supported` };
  return { usable: true, note: null };
}

/** 選單：自動、處理器、每張顯示卡；設定的卡不在清單裡時補一項，免得選單顯示成別的東西 */
export function decodeOptions(devices: readonly VideoDeviceDto[], objectDevices: readonly InferenceDeviceDto[], current: string): DecodeOption[] {
  const names = devices.map((d) => nameOf(d, objectDevices));
  const options: DecodeOption[] = [
    { value: DECODE_AUTO, label: t`Auto (default)` },
    { value: DECODE_CPU, label: t`CPU` },
  ];
  devices.forEach((d, i) => {
    const same = names.filter((n) => n === names[i]).length > 1;
    const { usable, note } = decodeLimit(d);
    options.push({
      value: d.id,
      label: same ? indexedName(names[i]!, names.slice(0, i + 1).filter((n) => n === names[i]).length) : names[i]!,
      disabled: !usable,
      desc: note ?? undefined,
    });
  });
  if (current !== DECODE_AUTO && current !== DECODE_CPU && !devices.some((d) => d.id === current)) options.push({ value: current, label: t`(not found right now, choosing automatically)` });
  return options;
}

export interface DecodeNote {
  tone: "ok" | "warn" | "muted";
  text: string;
}

/** 目前實際的解碼狀況，一行白話：使用中哪個裝置，或退回處理器的原因。技術細節（detail）不放 */
export function decodeNote(status: DecodeStatusDto | null, devices: readonly VideoDeviceDto[], objectDevices: readonly InferenceDeviceDto[]): DecodeNote | null {
  if (!status) return null;
  const label = (device: string | null) => {
    if (device === null) return t`CPU`;
    const d = devices.find((x) => x.id === device);
    return d ? nameOf(d, objectDevices) : t`Graphics card`;
  };
  const cams: readonly CameraDecodeDto[] = status.cameras;
  const reasons = [...new Set(cams.flatMap((c) => (c.fallback ? [serverText(c.fallback.reasonMsg, c.fallback.reason)] : [])))];
  if (reasons.length) return { tone: "warn", text: reasons.join("; ") };
  if (devices.length === 0 && status.requested === DECODE_AUTO) return { tone: "muted", text: t`No usable graphics card was detected, so the CPU is decoding.` };
  if (cams.length === 0) return null;
  const used = [...new Set(cams.filter((c) => c.device === null || c.confirmed).map((c) => label(c.device)))];
  const waiting = [...new Set(cams.filter((c) => !c.confirmed && c.device !== null).map((c) => label(c.device)))];
  if (used.length) {
    const names = joinClauses(used);
    return { tone: "ok", text: t`In use: ${names}` };
  }
  if (waiting.length) {
    const names = joinClauses(waiting);
    return { tone: "muted", text: t`Getting ready to use: ${names}` };
  }
  return null;
}
