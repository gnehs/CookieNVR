import type { DecodeStatusDto, VideoDeviceDto, VideoDevicesDto } from "../api-types.ts";
import type { CameraDecode } from "../detect/manager.ts";
import type { Env } from "../env.ts";
import { systemIo, type MetricsIo } from "../metrics/io.ts";
import type { HwParams } from "../messages/detection.ts";
import { msg, zh, type Msg } from "../messages/index.ts";
import type { CameraId, DeviceRef, Route } from "../types.ts";
import { probeVideoDevices, type ProbedDevice, type ProbeReport, type Runner } from "./probe.ts";

export interface VideoCodecsOptions {
  env: Pick<Env, "ffmpegBin">;
  tmpDir: string;
  io?: MetricsIo;
  run?: Runner;
  /** 每次試跑完成後呼叫（main 用來重新產生 detect worker 的規格） */
  onProbed?: (report: ProbeReport) => void;
  onError?: (e: unknown) => void;
}

export interface VideoCodecs {
  /** 最近一次試跑；還沒跑過為 null */
  current(): ProbeReport | null;
  /** 跑一次試跑；同時只有一個在跑，重複呼叫拿到同一個結果 */
  probe(): Promise<ProbeReport>;
  routes(status: () => DecodeStatusDto): Route[];
}

export function toDeviceDto(d: ProbedDevice): VideoDeviceDto {
  return { id: d.id, kind: d.kind, name: d.name, pci: d.pci, decode: d.decode, encode: d.encode };
}

export function createVideoCodecs(opts: VideoCodecsOptions): VideoCodecs {
  let report: ProbeReport | null = null;
  let inflight: Promise<ProbeReport> | null = null;

  function probe(): Promise<ProbeReport> {
    inflight ??= probeVideoDevices({ ffmpeg: opts.env.ffmpegBin, io: opts.io ?? systemIo, tmpDir: opts.tmpDir, run: opts.run })
      .then((r) => {
        report = r;
        try {
          opts.onProbed?.(r);
        } catch (e) {
          opts.onError?.(e);
        }
        return r;
      })
      .finally(() => (inflight = null));
    return inflight;
  }

  const devicesRoute = (status: () => DecodeStatusDto): Route => ({
    method: "GET",
    path: "/api/video-devices",
    access: "admin",
    async handler(ctx) {
      const r = ctx.url.searchParams.get("refresh") === "1" || !report ? await probe() : report;
      return Response.json({ probedAt: r.at, ffmpeg: r.ffmpeg, devices: r.devices.map(toDeviceDto), decode: status() } satisfies VideoDevicesDto);
    },
  });

  return { current: () => report, probe, routes: (status) => [devicesRoute(status)] };
}

/**
 * 狀態頁的提醒：哪幾台改用 CPU、為什麼。同一個原因只說一次；原因不同時只說第一個，
 * 其餘在診斷資訊。沒有退回時為 null。
 */
export function decodeWarningMsg(cameras: readonly CameraDecode[], nameOf: (id: CameraId) => string): Msg | null {
  const fell = cameras.filter((c) => c.fallback && c.device === null);
  const moved = cameras.filter((c) => c.fallback && c.device !== null);
  const first = (fell[0] ?? moved[0])?.fallback;
  if (!first) return null;
  const who = (list: readonly CameraDecode[]) => (list.length === 1 ? { camera: nameOf(list[0]!.cameraId) } : { count: list.length });
  // 原因是 hw.* 訊息：code 放進 reason，參數攤平（見 src/messages/detection.ts 的 DecodeWarnParams）
  const reason = { reason: first.reasonMsg.code, ...(first.reasonMsg.params as HwParams | undefined) };
  return fell.length ? msg("decode.warningCpu", { ...who(fell), ...reason }) : msg("decode.warningMoved", { ...who(moved), ...reason });
}

export function decodeWarning(cameras: readonly CameraDecode[], nameOf: (id: CameraId) => string): string | null {
  const m = decodeWarningMsg(cameras, nameOf);
  return m && zh(m);
}

export function decodeStatusDto(requested: DeviceRef, cameras: readonly CameraDecode[], nameOf: (id: CameraId) => string): DecodeStatusDto {
  const warningMsg = decodeWarningMsg(cameras, nameOf);
  return { requested, cameras: [...cameras], warning: warningMsg && zh(warningMsg), warningMsg };
}
