import { expect, test } from "bun:test";
import { detectCommand, parseHwDecode } from "../detect/command.ts";
import { fakeIo, ok } from "../metrics/fake-io.ts";
import { videoCodecOf } from "../restream/restream.ts";
import type { CameraId } from "../types.ts";
import { decodeTestCommand, encodeTestCommand, explainHwFailure, hwEnv, type HwApi } from "./commands.ts";
import { listVideoDevices, parseNvidiaList } from "./devices.ts";
import { planDecode, type HwDecode } from "./plan.ts";
import { probeVideoDevices, type CodecCheck, type ProbedDevice, type RunOutcome } from "./probe.ts";
import { decodeWarning } from "./service.ts";

const VAAPI: HwApi = { type: "vaapi", node: "/dev/dri/renderD128" };
const CUDA: HwApi = { type: "cuda", uuid: "GPU-aaaa-1111", index: 1 };
const hwOf = (api: HwApi): HwDecode => ({ deviceId: "x", name: "x", codec: "h264", api });

const after = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1];

test("detect 指令：CPU 與加入硬體解碼前一模一樣，沒有 hwaccel 也沒有 hwdownload", () => {
  const { cmd, env } = detectCommand("ffmpeg", "rtsp://x/sub", 1, null);
  expect(cmd).not.toContain("-hwaccel");
  expect(cmd.slice(1, 14)).toEqual(["-hide_banner", "-nostdin", "-loglevel", "warning", "-fflags", "nobuffer", "-probesize", "500000", "-analyzeduration", "500000", "-rtsp_transport", "tcp", "-timeout"]);
  expect(after(cmd, "-filter_complex")).toBe("[0:v:0]fps=5,scale=640:-2,split=2[a][b];[a]scale=320:180,format=gray[g];[b]fps=1[j]");
  expect(env).toEqual({});
});

test("detect 指令：Intel 用 VAAPI 的 render node，hwaccel 在 -i 前面，先降到每秒 5 張再搬回記憶體", () => {
  const { cmd, env } = detectCommand("ffmpeg", "rtsp://x/sub", 2, hwOf(VAAPI));
  expect(cmd.slice(cmd.indexOf("-hwaccel"), cmd.indexOf("-hwaccel") + 6)).toEqual(["-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi"]);
  expect(cmd.indexOf("-hwaccel")).toBeLessThan(cmd.indexOf("-i"));
  expect(after(cmd, "-filter_complex")).toStartWith("[0:v:0]fps=5,hwdownload,format=nv12|p010le,scale=640:-2,");
  expect(after(cmd, "-filter_complex")).toEndWith("[b]fps=2[j]");
  expect(cmd).not.toContain("nobuffer");
  expect(env).toEqual({});
});

test("detect 指令：Nvidia 用 UUID 只露出那一張卡，裝置編號固定 0；沒有 UUID 時依 PCI 順序的編號", () => {
  const withUuid = detectCommand("ffmpeg", "rtsp://x", 1, hwOf(CUDA));
  expect(after(withUuid.cmd, "-hwaccel")).toBe("cuda");
  expect(after(withUuid.cmd, "-hwaccel_device")).toBe("0");
  expect(after(withUuid.cmd, "-hwaccel_output_format")).toBe("cuda");
  expect(withUuid.env).toEqual({ CUDA_VISIBLE_DEVICES: "GPU-aaaa-1111" });
  const byIndex = detectCommand("ffmpeg", "rtsp://x", 1, hwOf({ type: "cuda", uuid: null, index: 1 }));
  expect(after(byIndex.cmd, "-hwaccel_device")).toBe("1");
  expect(byIndex.env).toEqual({ CUDA_DEVICE_ORDER: "PCI_BUS_ID" });
});

test("試跑指令：解碼一定經過 hwdownload；VAAPI 編碼先 hwupload，NVENC 直接收系統記憶體的畫面", () => {
  expect(decodeTestCommand("ffmpeg", VAAPI, "/t/s.mp4")).toContain("hwdownload,format=nv12|p010le");
  const vaEnc = encodeTestCommand("ffmpeg", VAAPI, "hevc");
  expect(after(vaEnc, "-init_hw_device")).toBe("vaapi=hw:/dev/dri/renderD128");
  expect(after(vaEnc, "-vf")).toBe("format=nv12,hwupload");
  expect(after(vaEnc, "-c:v")).toBe("hevc_vaapi");
  const nvEnc = encodeTestCommand("ffmpeg", CUDA, "h264");
  expect(nvEnc).not.toContain("-init_hw_device");
  expect(after(nvEnc, "-c:v")).toBe("h264_nvenc");
  expect(hwEnv(CUDA)).toEqual({ CUDA_VISIBLE_DEVICES: "GPU-aaaa-1111" });
});

test("worker 收到壞掉的硬體設定就當作 CPU", () => {
  expect(parseHwDecode(undefined)).toBeNull();
  expect(parseHwDecode("{nope")).toBeNull();
  expect(parseHwDecode(JSON.stringify({ deviceId: "x", api: { type: "opencl" } }))).toBeNull();
  expect(parseHwDecode(JSON.stringify(hwOf(VAAPI)))?.api).toEqual(VAAPI);
});

test("失敗原因：先認環境問題（裝置、權限、驅動元件），再認能力不足，認不出時說哪一步失敗", () => {
  const what = "H.265 硬體解碼";
  expect(explainHwFailure(VAAPI, what, "Failed to open the DRM device /dev/dri/renderD128: No such file or directory").reason).toContain("掛入 /dev/dri");
  expect(explainHwFailure(VAAPI, what, "/dev/dri/renderD128: Permission denied").reason).toContain("render 群組");
  expect(explainHwFailure(VAAPI, what, "libva info: va_openDriver() returns -1\nFailed to initialise VAAPI connection: -1 (unknown libva error).").reason).toContain("intel-media-va-driver");
  expect(explainHwFailure(CUDA, what, "Cannot load libnvcuvid.so.1").reason).toContain("NVIDIA_DRIVER_CAPABILITIES");
  expect(explainHwFailure(CUDA, what, "Cannot load libcuda.so.1\nDevice creation failed: -1.").reason).toContain("NVIDIA Container Toolkit");
  expect(explainHwFailure(CUDA, what, "Impossible to convert between the formats supported by the filter").reason).toBe("這張顯示卡不支援H.265 硬體解碼");
  expect(explainHwFailure(VAAPI, what, "", { timedOut: true }).reason).toBe("顯示卡沒有在時限內完成H.265 硬體解碼");
  const odd = explainHwFailure(VAAPI, what, "a\nb\nc\nd\ne\nf\ng\nsomething odd");
  expect(odd.reason).toBe("顯示卡無法H.265 硬體解碼");
  expect(odd.detail.split("\n")).toHaveLength(6);
});

test("nvidia-smi 的清單：名稱可含逗號，UUID 不對的行略過", () => {
  expect(parseNvidiaList("0, GPU-aaaa-1111, 00000000:01:00.0, NVIDIA GeForce RTX 3060\n1, GPU-bbbb-2222, 00000000:02:00.0, Quadro P400, Rev A\nbad line\n")).toEqual([
    { index: 0, uuid: "GPU-aaaa-1111", pci: "0000:01:00.0", name: "NVIDIA GeForce RTX 3060" },
    { index: 1, uuid: "GPU-bbbb-2222", pci: "0000:02:00.0", name: "Quadro P400, Rev A" },
  ]);
});

const drmCard = (card: string, pdev: string, render: string | null) => ({
  [`/sys/class/drm/${card}/device/vendor`]: "0x8086\n",
  [`/sys/class/drm/${card}/device/device`]: "0x3e92\n",
  ...(render ? { [`/sys/class/drm/${card}/device/drm/${render}/dev`]: "226:128" } : {}),
});

test("裝置清單：識別字與物件辨識同一套；Intel 內顯固定是 GPU.0，獨顯依 PCI 往後排；沒掛節點的卡標成不能用", async () => {
  const io = fakeIo({
    platform: "linux",
    files: { ...drmCard("card0", "0000:03:00.0", "renderD128"), ...drmCard("card1", "0000:00:02.0", "renderD129"), "/dev/dri/renderD129": "" },
    links: { "/sys/class/drm/card0/device": "/sys/devices/pci0000:00/0000:03:00.0", "/sys/class/drm/card1/device": "/sys/devices/pci0000:00/0000:00:02.0" },
    commands: { "nvidia-smi": ok("0, GPU-aaaa-1111, 00000000:01:00.0, NVIDIA GeForce RTX 3060\n") },
  });
  const list = await listVideoDevices(io);
  expect(list.map((d) => [d.id, d.pci, d.api, d.blocked === null])).toEqual([
    ["nvidia:GPU-aaaa-1111", "0000:01:00.0", { type: "cuda", uuid: "GPU-aaaa-1111", index: 0 }, true],
    ["intel:GPU.0", "0000:00:02.0", { type: "vaapi", node: "/dev/dri/renderD129" }, true],
    ["intel:GPU.1", "0000:03:00.0", { type: "vaapi", node: "/dev/dri/renderD128" }, false],
  ]);
  expect(list[2]!.blocked).toContain("/dev/dri/renderD128");
});

test("裝置清單：沒有 nvidia-smi 但有 /dev/nvidia0 時用編號；macOS 只有 VideoToolbox；其他平台沒有", async () => {
  expect((await listVideoDevices(fakeIo({ platform: "linux", files: { "/dev/nvidia0": "", "/dev/nvidiactl": "" } }))).map((d) => d.id)).toEqual(["nvidia:0"]);
  expect((await listVideoDevices(fakeIo({ platform: "darwin" }))).map((d) => d.id)).toEqual(["apple:0"]);
  expect(await listVideoDevices(fakeIo({ platform: "win32" }))).toEqual([]);
});

const yes: CodecCheck = { ok: true, ms: 100 };
const nope = (reason: string): CodecCheck => ({ ok: false, reason, detail: "ffmpeg said no" });
function dev(id: string, kind: ProbedDevice["kind"], h264: CodecCheck, hevc: CodecCheck): ProbedDevice {
  const api: HwApi = kind === "nvidia" ? CUDA : kind === "intel" ? VAAPI : { type: "videotoolbox" };
  return { id, kind, name: id, pci: null, api, blocked: null, decode: { h264, hevc }, encode: { h264: yes, hevc: yes } };
}
const intel = dev("intel:GPU.0", "intel", yes, yes);
const oldNvidia = dev("nvidia:GPU-1", "nvidia", yes, nope("這張顯示卡不支援H.265 硬體解碼"));

test("規劃：cpu 與還沒試跑完都用 CPU，不算退回", () => {
  expect(planDecode("cpu", [intel], "h264")).toEqual({ hw: null, note: null });
  expect(planDecode("intel:GPU.0", null, "h264")).toEqual({ hw: null, note: null });
});

test("規劃：指定的卡支援這個格式就用它，不支援就用 CPU 並說明原因", () => {
  expect(planDecode("nvidia:GPU-1", [oldNvidia, intel], "h264").hw?.deviceId).toBe("nvidia:GPU-1");
  const p = planDecode("nvidia:GPU-1", [oldNvidia, intel], "hevc");
  expect(p.hw).toBeNull();
  expect(p.note?.reason).toBe("這張顯示卡不支援H.265 硬體解碼");
});

test("規劃：自動依序 Nvidia、Intel，跳過不支援這個格式的卡；格式未知時當作 H.264", () => {
  expect(planDecode("auto", [intel, oldNvidia], null).hw?.deviceId).toBe("nvidia:GPU-1");
  expect(planDecode("auto", [intel, oldNvidia], "hevc")).toMatchObject({ hw: { deviceId: "intel:GPU.0", codec: "hevc" }, note: null });
  expect(planDecode("auto", [], "h264")).toEqual({ hw: null, note: null });
});

test("規劃：自動模式有卡卻都不能用時要說明；指定的卡不見了改用自動並說明", () => {
  const broken = dev("intel:GPU.0", "intel", nope("沒有權限使用顯示卡"), nope("沒有權限使用顯示卡"));
  expect(planDecode("auto", [broken], "h264")).toMatchObject({ hw: null, note: { reason: "intel:GPU.0：沒有權限使用顯示卡" } });
  const moved = planDecode("nvidia:GPU-gone", [intel], "h264");
  expect(moved.hw?.deviceId).toBe("intel:GPU.0");
  expect(moved.note?.reason).toContain("找不到設定的顯示卡");
  expect(planDecode("nvidia:GPU-gone", [], "h264")).toMatchObject({ hw: null, note: { reason: expect.stringContaining("找不到設定的顯示卡") } });
});

const done = (code: number | null, stderr = "", timedOut = false): RunOutcome => ({ code, stderr, stdout: code === 0 ? "ffmpeg version 7.1.5\n" : "", timedOut, ms: 50 });

test("試跑：每張卡每種格式各跑一次解碼與編碼，失敗附白話原因；沒掛節點的卡不必跑", async () => {
  const io = fakeIo({
    platform: "linux",
    files: { ...drmCard("card0", "0000:00:02.0", "renderD128"), "/dev/dri/renderD128": "" },
    links: { "/sys/class/drm/card0/device": "/sys/devices/pci0000:00/0000:00:02.0" },
    commands: { "nvidia-smi": ok("0, GPU-aaaa-1111, 00000000:01:00.0, Quadro P400\n") },
  });
  const ran: { cmd: string[]; env: Record<string, string> }[] = [];
  const report = await probeVideoDevices({
    ffmpeg: "ffmpeg",
    io,
    tmpDir: `${process.env.TMPDIR ?? "/tmp"}/hwcodec-test-${process.pid}`,
    now: () => 1000,
    run: async (cmd, env) => {
      ran.push({ cmd, env });
      if (cmd.includes("-version")) return done(0);
      if (cmd.includes("hevc_nvenc")) return done(1, "[hevc_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2)");
      if (cmd.includes("cuda") && cmd.some((a) => a.endsWith("sample-hevc.mp4"))) return done(1, "Impossible to convert between the formats supported by the filter");
      return done(0);
    },
  });
  expect(report.ffmpeg).toBe("ffmpeg version 7.1.5");
  const [nv, it] = report.devices;
  expect(nv!.decode.h264.ok).toBe(true);
  expect(nv!.decode.hevc).toMatchObject({ ok: false, reason: "這張顯示卡不支援H.265 硬體解碼" });
  expect(nv!.encode.hevc).toMatchObject({ ok: false, reason: expect.stringContaining("NVIDIA_DRIVER_CAPABILITIES") });
  expect(it!.decode.hevc.ok).toBe(true);
  expect(ran.filter((r) => r.cmd.includes("cuda") || r.cmd.some((a) => a.includes("nvenc"))).every((r) => r.env.CUDA_VISIBLE_DEVICES === "GPU-aaaa-1111")).toBe(true);
});

test("試跑：產生不了 H.265 試跑影片時那一格標成無法測試，不冤枉顯示卡", async () => {
  const report = await probeVideoDevices({
    ffmpeg: "ffmpeg",
    io: fakeIo({ platform: "darwin" }),
    tmpDir: `${process.env.TMPDIR ?? "/tmp"}/hwcodec-test2-${process.pid}`,
    run: async (cmd) => (cmd.includes("libx265") ? done(1, "Unknown encoder 'libx265'") : done(0)),
  });
  expect(report.devices[0]!.decode.hevc).toMatchObject({ ok: false, reason: expect.stringContaining("無法產生 H.265 的試跑影片") });
  expect(report.devices[0]!.decode.h264.ok).toBe(true);
});

test("MediaMTX 的軌道：新舊兩種格式都認得，還沒連上時不知道", () => {
  expect(videoCodecOf({ ready: true, tracks: ["H265", "MPEG-4 Audio"] })).toBe("hevc");
  expect(videoCodecOf({ ready: true, tracks2: [{ codec: "MPEG-4 Audio" }, { codec: "H264" }] })).toBe("h264");
  expect(videoCodecOf({ ready: false, tracks: ["H264"] })).toBeNull();
  expect(videoCodecOf({ ready: true, tracks: ["MJPEG"] })).toBeNull();
  expect(videoCodecOf(null)).toBeNull();
});

test("狀態頁提醒：一台說名字、多台說台數；改用另一張卡也提醒；沒有退回時沒有提醒", () => {
  const f = { reason: "沒有權限使用顯示卡", detail: "" };
  const a = "a" as CameraId;
  const b = "b" as CameraId;
  const name = (id: CameraId) => (id === a ? "客廳" : "車庫");
  expect(decodeWarning([{ cameraId: a, device: null, confirmed: false, fallback: f }], name)).toBe("客廳改用處理器解碼：沒有權限使用顯示卡");
  expect(decodeWarning([a, b].map((cameraId) => ({ cameraId, device: null, confirmed: false, fallback: f })), name)).toBe("2 台攝影機改用處理器解碼：沒有權限使用顯示卡");
  expect(decodeWarning([{ cameraId: a, device: "intel:GPU.0", confirmed: true, fallback: f }], name)).toBe("客廳沒有用設定的顯示卡解碼：沒有權限使用顯示卡");
  expect(decodeWarning([{ cameraId: a, device: "intel:GPU.0", confirmed: true, fallback: null }], name)).toBeNull();
});
