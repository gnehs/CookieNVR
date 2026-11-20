import { expect, test } from "bun:test";
import { msg, zh, type Msg } from "../messages/index.ts";
import { detectCommand, parseHwDecode } from "../detect/command.ts";
import { fakeIo, ok } from "../metrics/fake-io.ts";
import { videoCodecOf } from "../restream/restream.ts";
import type { CameraId } from "../types.ts";
import { decodeTestCommand, encodeTestCommand, explainHwFailure, hwEnv, inputFailed, sampleCommand, type HwApi, type HwWhat } from "./commands.ts";
import { listVideoDevices, parseNvidiaList } from "./devices.ts";
import { planDecode, type HwDecode } from "./plan.ts";
import { probeVideoDevices, type CodecCheck, type ProbedDevice, type RunOutcome } from "./probe.ts";
import { decodeWarning, decodeWarningMsg } from "./service.ts";

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

// 使用者在 RTX 5060 Ti（12 核心）上的 ffmpeg 7.1.5 輸出，位址遮蔽過
const NVDEC_SURFACES = `[h264 @ 0x55fcef2cc0c0] decoder->cvdl->cuvidCreateDecoder(&decoder->decoder, params) failed -> CUDA_ERROR_INVALID_VALUE: invalid argument
[h264 @ 0x55fcef2cc0c0] Using more than 32 (34) decode surfaces might cause nvdec to fail.
[h264 @ 0x55fcef2cc0c0] Try lowering the amount of threads. Using 13 right now.
[h264 @ 0x55fcef2cc0c0] Failed setup for format cuda: hwaccel initialisation returned error.
Impossible to convert between the formats supported by the filter 'Parsed_fps_0' and the filter 'auto_scale_0'
[fc#0 @ 0x1] Error reinitializing filters!
[vost#1:0/mjpeg @ 0x1] Could not open encoder before EOF
[out#0/rawvideo @ 0x1] Nothing was written into output file, because at least one of its streams received no packets.`;
const PATH_MISSING = `[rtsp @ 0x1] method DESCRIBE failed: 404 Not Found
Error opening input file rtsp://***@127.0.0.1:8554/y3z77qrh/sub.
Error opening input files: Server returned 404 Not Found`;
const PATH_BAD_REQUEST = `[rtsp @ 0x1] method DESCRIBE failed: 400 Bad Request
[in#0 @ 0x1] Error opening input: Server returned 400 Bad Request
Error opening input file rtsp://***@127.0.0.1:8554/y3z77qrh/main.`;
const NVDEC_LACKING = `[hevc @ 0x1] Hardware is lacking required capabilities
[hevc @ 0x1] Failed setup for format cuda: hwaccel initialisation returned error.
Impossible to convert between the formats supported by the filter 'Parsed_fps_0' and the filter 'auto_scale_0'`;

test("失敗原因：NVDEC 的解碼器建不起來是啟動失敗，不是不支援", () => {
  expect(explainHwFailure(CUDA, { codec: "h264", op: "decode" }, NVDEC_SURFACES).reason).toBe("顯示卡啟動 H.264 硬體解碼失敗");
  expect(explainHwFailure(VAAPI, { codec: "h264", op: "decode" }, "[h264 @ 0x1] Failed setup for format vaapi: hwaccel initialisation returned error.").reason).toBe("顯示卡啟動 H.264 硬體解碼失敗");
});

test("輸入端打不開不算顯示卡失敗；有任何顯示卡的訊息就算", () => {
  expect(inputFailed(PATH_MISSING)).toBe(true);
  expect(inputFailed(PATH_BAD_REQUEST)).toBe(true);
  expect(inputFailed("[tcp @ 0x1] Connection to tcp://10.0.0.9:554?timeout=10000000 failed: Connection refused\nError opening input file rtsp://***@10.0.0.9/stream1.")).toBe(true);
  expect(inputFailed(NVDEC_SURFACES)).toBe(false);
  expect(inputFailed(NVDEC_LACKING)).toBe(false);
  expect(inputFailed("")).toBe(false);
  expect(inputFailed(`[rtsp @ 0x1] method DESCRIBE failed: 404 Not Found\nDevice creation failed: -22.`)).toBe(false);
});

test("硬體解碼只用一條解碼執行緒：NVDEC 的畫面緩衝依執行緒數增加，上限 32；試跑與 worker 是同一組參數", () => {
  const { cmd } = detectCommand("ffmpeg", "rtsp://x/sub", 1, hwOf(CUDA));
  expect(after(cmd, "-threads")).toBe("1");
  expect(cmd.indexOf("-threads")).toBeLessThan(cmd.indexOf("-i"));
  const probe = decodeTestCommand("ffmpeg", CUDA, "/t/s.mp4");
  expect(after(probe, "-threads")).toBe("1");
  expect(probe.indexOf("-threads")).toBeLessThan(probe.indexOf("-i"));
  expect(detectCommand("ffmpeg", "rtsp://x/sub", 1, null).cmd).not.toContain("-threads");
});

test("試跑短片的參考幀不少於一般攝影機，畫面緩衝不夠的問題在試跑就出現", () => {
  expect(after(sampleCommand("ffmpeg", "h264", "/t/s.mp4"), "-refs")).toBe("8");
  expect(after(sampleCommand("ffmpeg", "hevc", "/t/s.mp4"), "-x265-params")).toContain("ref=8");
});

test("失敗原因：先認環境問題（裝置、權限、驅動元件），再認能力不足，認不出時說哪一步失敗", () => {
  const what: HwWhat = { codec: "hevc", op: "decode" };
  expect(explainHwFailure(VAAPI, what, "Failed to open the DRM device /dev/dri/renderD128: No such file or directory").reason).toContain("掛入 /dev/dri");
  expect(explainHwFailure(VAAPI, what, "/dev/dri/renderD128: Permission denied").reason).toContain("render 群組");
  // Debian ffmpeg 7.1.5 在沒有 GPU 的容器裡實際印出的訊息
  expect(explainHwFailure(VAAPI, what, "[AVHWDeviceContext @ 0x5] No VA display found for device /dev/dri/renderD128.\nDevice creation failed: -22.").reason).toContain("無法開啟顯示卡（/dev/dri/renderD128）");
  expect(explainHwFailure(CUDA, what, "[AVHWDeviceContext @ 0x5] Cannot load libcuda.so.1\n[AVHWDeviceContext @ 0x5] Could not dynamically load CUDA\nDevice creation failed: -1.").reason).toContain("NVIDIA Container Toolkit");
  expect(explainHwFailure(VAAPI, what, "libva info: va_openDriver() returns -1\nFailed to initialise VAAPI connection: -1 (unknown libva error).").reason).toContain("intel-media-va-driver");
  expect(explainHwFailure(CUDA, what, "Cannot load libnvcuvid.so.1").reason).toContain("NVIDIA_DRIVER_CAPABILITIES");
  expect(explainHwFailure(CUDA, what, "Cannot load libcuda.so.1\nDevice creation failed: -1.").reason).toContain("NVIDIA Container Toolkit");
  expect(explainHwFailure(CUDA, what, NVDEC_LACKING).reason).toBe("這張顯示卡不支援 H.265 硬體解碼");
  expect(explainHwFailure(VAAPI, what, "", { timedOut: true }).reason).toBe("顯示卡沒有在時限內完成 H.265 硬體解碼");
  const odd = explainHwFailure(VAAPI, what, "a\nb\nc\nd\ne\nf\ng\nsomething odd");
  expect(odd.reason).toBe("顯示卡沒有完成 H.265 硬體解碼");
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
  expect(list[2]!.blocked).toEqual(msg("hw.nodeMissing", { node: "/dev/dri/renderD128" }));
});

test("裝置清單：沒有 nvidia-smi 但有 /dev/nvidia0 時用編號；macOS 只有 VideoToolbox；其他平台沒有", async () => {
  expect((await listVideoDevices(fakeIo({ platform: "linux", files: { "/dev/nvidia0": "", "/dev/nvidiactl": "" } }))).map((d) => d.id)).toEqual(["nvidia:0"]);
  expect((await listVideoDevices(fakeIo({ platform: "darwin" }))).map((d) => d.id)).toEqual(["apple:0"]);
  expect(await listVideoDevices(fakeIo({ platform: "win32" }))).toEqual([]);
});

const yes: CodecCheck = { ok: true, ms: 100 };
const nope = (reasonMsg: Msg): CodecCheck => ({ ok: false, reason: zh(reasonMsg), detail: "ffmpeg said no", reasonMsg });
function dev(id: string, kind: ProbedDevice["kind"], h264: CodecCheck, hevc: CodecCheck): ProbedDevice {
  const api: HwApi = kind === "nvidia" ? CUDA : kind === "intel" ? VAAPI : { type: "videotoolbox" };
  return { id, kind, name: id, pci: null, api, blocked: null, decode: { h264, hevc }, encode: { h264: yes, hevc: yes } };
}
const intel = dev("intel:GPU.0", "intel", yes, yes);
const oldNvidia = dev("nvidia:GPU-1", "nvidia", yes, nope(msg("hw.unsupported", { codec: "H.265", op: "decode" })));

test("規劃：cpu 與還沒試跑完都用 CPU，不算退回", () => {
  expect(planDecode("cpu", [intel], "h264")).toEqual({ hw: null, note: null });
  expect(planDecode("intel:GPU.0", null, "h264")).toEqual({ hw: null, note: null });
});

test("規劃：指定的卡支援這個格式就用它，不支援就用 CPU 並說明原因", () => {
  expect(planDecode("nvidia:GPU-1", [oldNvidia, intel], "h264").hw?.deviceId).toBe("nvidia:GPU-1");
  const p = planDecode("nvidia:GPU-1", [oldNvidia, intel], "hevc");
  expect(p.hw).toBeNull();
  expect(p.note?.reason).toBe("這張顯示卡不支援 H.265 硬體解碼");
  expect(p.note?.reasonMsg).toEqual(msg("hw.unsupported", { codec: "H.265", op: "decode" }));
});

test("規劃：指定的卡不能解這個格式，原因不含格式名稱時補在後面", () => {
  const p = planDecode("intel:GPU.0", [dev("intel:GPU.0", "intel", yes, nope(msg("hw.noPermission", { node: "/dev/dri/renderD128" })))], "hevc");
  expect(p.note?.reason).toBe("沒有權限使用顯示卡（/dev/dri/renderD128），請把容器加入主機的 render 群組（H.265）");
});

test("規劃：自動依序 Nvidia、Intel，跳過不支援這個格式的卡；格式未知時當作 H.264", () => {
  expect(planDecode("auto", [intel, oldNvidia], null).hw?.deviceId).toBe("nvidia:GPU-1");
  expect(planDecode("auto", [intel, oldNvidia], "hevc")).toMatchObject({ hw: { deviceId: "intel:GPU.0", codec: "hevc" }, note: null });
  expect(planDecode("auto", [], "h264")).toEqual({ hw: null, note: null });
});

test("規劃：自動模式有卡卻都不能用時要說明；指定的卡不見了改用自動並說明", () => {
  const broken = dev("intel:GPU.0", "intel", nope(msg("hw.noPermission", { node: "/dev/dri/renderD128" })), nope(msg("hw.noPermission", { node: "/dev/dri/renderD128" })));
  expect(planDecode("auto", [broken], "h264")).toMatchObject({ hw: null, note: { reason: "intel:GPU.0：沒有權限使用顯示卡（/dev/dri/renderD128），請把容器加入主機的 render 群組", reasonMsg: { code: "hw.noPermission", params: { node: "/dev/dri/renderD128", device: "intel:GPU.0" } } } });
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
      if (cmd.includes("cuda") && cmd.some((a) => a.endsWith("sample-hevc.mp4"))) return done(1, NVDEC_LACKING);
      return done(0);
    },
  });
  expect(report.ffmpeg).toBe("ffmpeg version 7.1.5");
  const [nv, it] = report.devices;
  expect(nv!.decode.h264.ok).toBe(true);
  expect(nv!.decode.hevc).toMatchObject({ ok: false, reason: "這張顯示卡不支援 H.265 硬體解碼" });
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
  const f = { reason: "沒有權限使用顯示卡", detail: "", reasonMsg: msg("hw.noPermission", { node: "/dev/dri/renderD128" }) };
  const a = "a" as CameraId;
  const b = "b" as CameraId;
  const name = (id: CameraId) => (id === a ? "客廳" : "車庫");
  expect(decodeWarning([{ cameraId: a, device: null, confirmed: false, fallback: f }], name)).toBe("客廳改用處理器解碼：沒有權限使用顯示卡（/dev/dri/renderD128），請把容器加入主機的 render 群組");
  expect(decodeWarning([a, b].map((cameraId) => ({ cameraId, device: null, confirmed: false, fallback: f })), name)).toBe("2 台攝影機改用處理器解碼：沒有權限使用顯示卡（/dev/dri/renderD128），請把容器加入主機的 render 群組");
  expect(decodeWarning([{ cameraId: a, device: "intel:GPU.0", confirmed: true, fallback: f }], name)).toBe("客廳沒有用設定的顯示卡解碼：沒有權限使用顯示卡（/dev/dri/renderD128），請把容器加入主機的 render 群組");
  expect(decodeWarning([{ cameraId: a, device: "intel:GPU.0", confirmed: true, fallback: null }], name)).toBeNull();
  expect(decodeWarningMsg([{ cameraId: a, device: null, confirmed: false, fallback: f }], name)).toEqual({ code: "decode.warningCpu", params: { camera: "客廳", reason: "hw.noPermission", node: "/dev/dri/renderD128" } });
});
