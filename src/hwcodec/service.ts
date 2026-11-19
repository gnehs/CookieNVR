import type { DecodeStatusDto, VideoDeviceDto, VideoDevicesDto } from "../api-types.ts";
import type { CameraDecode } from "../detect/manager.ts";
import type { Env } from "../env.ts";
import { systemIo, type MetricsIo } from "../metrics/io.ts";
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
export function decodeWarning(cameras: readonly CameraDecode[], nameOf: (id: CameraId) => string): string | null {
  const fell = cameras.filter((c) => c.fallback && c.device === null);
  const moved = cameras.filter((c) => c.fallback && c.device !== null);
  const first = (fell[0] ?? moved[0])?.fallback;
  if (!first) return null;
  const who = (list: readonly CameraDecode[]) => (list.length === 1 ? nameOf(list[0]!.cameraId) : `${list.length} 台攝影機`);
  if (fell.length) return `${who(fell)}改用處理器解碼：${first.reason}`;
  return `${who(moved)}沒有用設定的顯示卡解碼：${first.reason}`;
}

export function decodeStatusDto(requested: DeviceRef, cameras: readonly CameraDecode[], nameOf: (id: CameraId) => string): DecodeStatusDto {
  return { requested, cameras: [...cameras], warning: decodeWarning(cameras, nameOf) };
}
