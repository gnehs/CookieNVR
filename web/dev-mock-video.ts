// 假後端的影像硬體解碼：顯示卡試跑結果與每台的解碼方式。
// 切換：啟動時 MOCK_VIDEO=both|intel|none|broken（預設 both：Intel 內顯加一張 Nvidia）；
//   broken：有 Intel 內顯但容器沒掛 /dev/dri，選它的攝影機會退回處理器並出現狀態頁提醒。
// 解碼設定用 MOCK_DECODE（預設 auto），之後在設定頁改。
import type { CodecCheckDto, DecodeStatusDto, VideoDeviceDto, VideoDevicesDto } from "../src/api-types.ts";
import { msg, zh, type Msg } from "../src/messages/index.ts";
import type { CameraId, DeviceRef } from "../src/types.ts";

type MockVideo = "both" | "intel" | "none" | "broken";
const MODE: MockVideo = (["both", "intel", "none", "broken"] as const).find((v) => v === process.env.MOCK_VIDEO) ?? "both";

const ok = (ms: number): CodecCheckDto => ({ ok: true, ms });
const no = (reasonMsg: Msg, detail: string): CodecCheckDto => ({ ok: false, reason: zh(reasonMsg), reasonMsg, detail });
const MISSING_NODE = no(msg("hw.nodeMissing", { node: "/dev/dri/renderD128" }), "device node missing");

const INTEL: VideoDeviceDto = {
  id: "intel:GPU.0",
  kind: "intel",
  name: "Intel 內顯",
  pci: "0000:00:02.0",
  decode: { h264: ok(182), hevc: ok(195) },
  encode: { h264: ok(240), hevc: no(msg("hw.unsupported", { codec: "H.265", op: "encode" }), "[hevc_vaapi @ 0x55] No usable encoding profile found.") },
};
const NVIDIA: VideoDeviceDto = {
  id: "nvidia:GPU-8c6d1a2e-0b4f-4c55-9d1a-2b3c4d5e6f70",
  kind: "nvidia",
  name: "NVIDIA GeForce RTX 3060",
  pci: "0000:01:00.0",
  decode: { h264: ok(410), hevc: ok(398) },
  encode: { h264: ok(452), hevc: ok(460) },
};

function devices(): VideoDeviceDto[] {
  if (MODE === "none") return [];
  if (MODE === "broken") return [{ ...INTEL, decode: { h264: MISSING_NODE, hevc: MISSING_NODE }, encode: { h264: MISSING_NODE, hevc: MISSING_NODE } }];
  return MODE === "intel" ? [INTEL] : [NVIDIA, INTEL];
}

/** 和真後端的 planDecode 同一套規則的簡化版：auto 依序 Nvidia、Intel；選的卡不能解就退回處理器 */
export function mockDecodeStatus(requested: DeviceRef, cams: { id: CameraId; name: string }[]): DecodeStatusDto {
  const list = devices();
  const pick = requested === "cpu" ? null : requested === "auto" ? (list.find((d) => d.decode.h264.ok) ?? null) : (list.find((d) => d.id === requested) ?? list.find((d) => d.decode.h264.ok) ?? null);
  const check = pick?.decode.h264;
  const first = list[0]?.decode.h264;
  const fail = (m: Msg, detail: string) => ({ reason: zh(m), reasonMsg: m, detail });
  const extend = (m: Msg, extra: Record<string, string>): Msg => ({ ...m, params: { ...(m.params as object | undefined), ...extra } }) as Msg;
  const autoNote = !pick && first && !first.ok ? fail(extend(first.reasonMsg, { device: list[0]!.name }), first.detail) : null;
  const missing = requested !== "cpu" && requested !== "auto" && !list.some((d) => d.id === requested);
  const fallback = requested === "cpu" ? null : missing ? fail(msg("hw.deviceGone", {}), `requested ${requested}`) : !pick ? autoNote : check && !check.ok ? fail(check.reasonMsg, check.detail) : null;
  const device = pick && check?.ok ? pick.id : null;
  const cameras = cams.map((c) => ({ cameraId: c.id, device, confirmed: device !== null, fallback }));
  const who = cams.length === 1 ? { camera: cams[0]!.name } : { count: cams.length };
  const warningMsg = fallback && device === null && cams.length ? msg("decode.warningCpu", { ...who, reason: fallback.reasonMsg.code, ...(fallback.reasonMsg.params as object | undefined) }) : null;
  const warning = warningMsg && zh(warningMsg);
  return { requested, cameras, warning, warningMsg };
}

export function mockVideoDevices(requested: DeviceRef, cams: { id: CameraId; name: string }[]): VideoDevicesDto {
  return { probedAt: Date.now() - 90_000, ffmpeg: "ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers", devices: devices(), decode: mockDecodeStatus(requested, cams) };
}
