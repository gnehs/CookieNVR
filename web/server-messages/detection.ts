import { t } from "@lingui/core/macro";
import type { detection as zh, hwReasons as zhHw, HwParams } from "../../src/messages/detection.ts";
import { joinList } from "../format.ts";
import type { Translations } from "../server-text.ts";

/** 失敗原因前面補顯示卡名稱，或後面補影像格式（見 src/messages/detection.ts 的 HwParams） */
function wrap(p: HwParams, text: string): string {
  const { device, forCodec } = p;
  if (device) return t`${device}: ${text}`;
  if (forCodec) return t`${text} (${forCodec})`;
  return text;
}

/** 「H.265 硬體解碼」這類說法 */
function what(p: HwParams): string {
  const codec = p.codec ?? "";
  return p.op === "encode" ? t`${codec} hardware encoding` : t`${codec} hardware decoding`;
}

export const hwReasons: Translations<typeof zhHw> = {
  "hw.noDriNode": (p) => {
    const node = p.node ?? "";
    return wrap(p, t`The container doesn't have the device for this graphics card (${node}). Mount /dev/dri in the container settings`);
  },
  "hw.cannotOpenGpu": (p) => {
    const node = p.node ?? "";
    return wrap(p, t`Can't open the graphics card (${node}). Make sure /dev/dri is mounted in the container and the container has joined the host's render group`);
  },
  "hw.noPermission": (p) => {
    const node = p.node ?? "";
    return wrap(p, t`No permission to use the graphics card (${node}). Add the container to the host's render group`);
  },
  "hw.noVaDriver": (p) => wrap(p, t`The Intel video driver (VAAPI) wasn't found. The image may be missing intel-media-va-driver`),
  "hw.noNvidiaVideo": (p) => wrap(p, t`The container hasn't loaded Nvidia's video codec libraries. NVIDIA_DRIVER_CAPABILITIES in the container settings must include video`),
  "hw.noNvidiaDriver": (p) => wrap(p, t`The container has no Nvidia driver. Start it with the NVIDIA Container Toolkit`),
  "hw.unsupported": (p) => {
    const w = what(p);
    return wrap(p, t`This graphics card doesn't support ${w}`);
  },
  "hw.setupFailed": (p) => {
    const w = what(p);
    return wrap(p, t`The graphics card failed to start ${w}`);
  },
  "hw.timeout": (p) => {
    const w = what(p);
    return wrap(p, t`The graphics card didn't finish ${w} in time`);
  },
  "hw.failed": (p) => {
    const w = what(p);
    return wrap(p, t`The graphics card didn't complete ${w}`);
  },
  "hw.sampleFailed": (p) => {
    const codec = p.codec ?? "";
    return wrap(p, t`Couldn't create a ${codec} test clip (this ffmpeg may not have a software encoder)`);
  },
  "hw.nodeMissing": (p) => {
    const node = p.node ?? "";
    return wrap(p, t`The host has this Intel graphics card, but ${node} isn't in the container. Mount /dev/dri in the container settings`);
  },
  "hw.deviceGone": (p) => wrap(p, t`The selected graphics card wasn't found (it may have been removed or replaced). Switched to automatic selection`),
};

function hwReason(p: { reason: string; text?: string } & HwParams): string {
  if (p.reason === "raw") return p.text ?? "";
  const fn = (hwReasons as Record<string, ((p: HwParams) => string) | undefined>)[p.reason];
  return fn ? fn(p) : "";
}

function gpuItem(code: string): string {
  switch (code) {
    case "utilization":
      return t`utilization`;
    case "memory":
      return t`graphics memory`;
    case "temperature":
      return t`temperature`;
    default:
      return code;
  }
}

export const detection: Translations<typeof zh> = {
  ...hwReasons,
  "decode.warningCpu": (p) => {
    const reason = hwReason(p);
    if (p.camera !== undefined) {
      const camera = p.camera;
      return t`${camera} switched to CPU decoding: ${reason}`;
    }
    const count = p.count ?? 0;
    return t`${count} cameras switched to CPU decoding: ${reason}`;
  },
  "decode.warningMoved": (p) => {
    const reason = hwReason(p);
    if (p.camera !== undefined) {
      const camera = p.camera;
      return t`${camera} isn't decoding on the selected graphics card: ${reason}`;
    }
    const count = p.count ?? 0;
    return t`${count} cameras aren't decoding on the selected graphics card: ${reason}`;
  },

  "objects.notReady": () => t`Object detection isn't ready yet. Turn it on and wait for it to finish loading, then run the benchmark`,
  "objects.benchRunning": () => t`A benchmark is already running`,
  "objects.unknownDevices": ({ devices }) => {
    const list = joinList(devices);
    return t`Devices not found: ${list}`;
  },
  "objects.dropWarning": ({ percent }) => t`${percent}% of recent frames were too late to analyze. Lower the detection rate or switch to a faster device.`,
  "objects.capacityWarning": ({ cameras, supported }) =>
    t`When the ${cameras} cameras with object detection all see motion at once, it can't keep up. This machine can handle about ${supported} at a time. Lower the detection rate or switch to a faster device.`,
  "objects.benchInterrupted": () => t`The detector restarted, so the benchmark was interrupted`,
  "objects.gpuLabel": () => t`Object detection`,
  "objects.gpuBenchmarking": () => t`Benchmarking`,
  "objects.gpuRate": ({ fps }) => t`${fps} frames/s`,

  "gpu.notProvided": ({ items }) => {
    const list = joinList(items.map(gpuItem));
    return t`This graphics card doesn't report ${list}`;
  },
  "gpu.noUtilization": () => t`This GPU doesn't report utilization`,

  "detector.noIntelRuntime": () => t`This image has no Intel graphics inference components (only the amd64 image does)`,
  "detector.noDri": () => t`No Intel graphics found in the container (/dev/dri). Mount /dev/dri in the container settings`,
  "detector.driNoAccess": () => t`No permission to use /dev/dri. Add the container to the host's render group (--group-add)`,
  "detector.byPathMissing": () =>
    t`The Intel graphics link in /dev/dri/by-path is missing, so OpenVINO can't find it. Start the container as root (you can drop privileges with PUID/PGID) so CookieNVR can add it automatically`,
  "detector.openvinoNoGpu": () => t`OpenVINO can't see the Intel graphics. The driver may not support this GPU`,
  "detector.noNvidiaRuntime": () => t`This image has no Nvidia inference components. Use the latest-nvidia image`,
  "detector.noNvidiaGpu": () =>
    t`No Nvidia graphics card is visible in the container. Make sure the NVIDIA Container Toolkit is installed on the host, and start the container with --gpus all or runtime: nvidia`,
  "detector.noIntelDetected": () => t`No Intel graphics detected`,
  "detector.noNvidiaDetected": () => t`No Nvidia graphics card detected`,
  "detector.deviceGone": () => t`The selected device wasn't found (it may have been removed or replaced). Switched to automatic selection`,
  "detector.notOnDevice": ({ device, runtime }) => t`${device} isn't actually running this model (${runtime} handed the work back to the CPU). Switched to another device`,
  "detector.notOnDeviceBench": ({ device, runtime }) => t`${device} isn't actually running this model (${runtime} handed the work back to the CPU). This device isn't suitable for detection`,
  "detector.loadFailed": ({ device }) => t`${device} failed to load the model. Switched to another device`,
  "detector.benchDeviceMissing": () => t`This device wasn't found`,
  "detector.modelLoadFailed": () => t`The model failed to load`,
  "detector.modelNotOnnx": () => t`Couldn't load the model. The file may not be a valid ONNX model`,
  "detector.modelFileMissing": ({ file }) => t`Model file ${file} not found`,
  "detector.modelInputShape": ({ shape }) => t`The model's input should be an image of shape [1, 3, height, width], but this model's is ${shape}`,
  "detector.modelInputSize": ({ width, height }) => t`The model's input size ${width}×${height} isn't a multiple of 32, so it doesn't look like a YOLO model`,
  "detector.modelNoClassNames": ({ count }) =>
    t`The model has ${count} classes but no class names. Only COCO 80 classes or models with names in their metadata are supported`,
  "detector.modelOutputShape": ({ shape }) =>
    t`Can't make sense of the model's output shape ${shape}. Supported: YOLOX ([1, N, 85]), Ultralytics YOLOv8 / 11 ([1, 84, N]) and models with NMS built in ([1, K, 6])`,
  "detector.modelOutputGrid": ({ shape, width, height, expected }) =>
    t`Can't make sense of the model's output shape ${shape} (input ${width}×${height}, expected ${expected} grid points). Supported: YOLOX ([1, N, 85]), Ultralytics YOLOv8 / 11 ([1, 84, N]) and models with NMS built in ([1, K, 6])`,
  "detector.modelInputCount": ({ count }) => t`The model should have exactly one image input, but this one has ${count}`,
  "detector.modelInputType": ({ type }) => t`The model's input type is ${type}. Only float32 is supported`,
};
