import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fakeIo, ok } from "./fake-io.ts";
import { createIntelProbe, probeApple, probeNvidia } from "./gpu.ts";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();

describe("Nvidia", () => {
  test("two GPUs from nvidia-smi; unsupported values become a note", async () => {
    const io = fakeIo({ platform: "linux", commands: { "nvidia-smi": ok(await fixture("nvidia-smi.csv")) } });
    const r = await probeNvidia(io);
    expect(r.state).toBe("ok");
    expect(r.gpus.map((g) => g.id)).toEqual(["nvidia:0000:01:00.0", "nvidia:0000:02:00.0"]);
    expect(r.gpus[0]!.memory).toEqual({ usedBytes: 1834 * 1048576, totalBytes: 12288 * 1048576 });
    expect(r.gpus[0]!.note).toBeNull();
    expect(r.gpus[1]!.utilPct).toBeNull();
    expect(r.gpus[1]!.note).toBe("這張顯示卡不提供使用率、溫度");
  });
  test("no nvidia-smi and no device: absent", async () => {
    const r = await probeNvidia(fakeIo({ platform: "linux" }));
    expect(r.state).toBe("absent");
  });
  test("device passed in but no utility capability: an error that says what to set", async () => {
    const r = await probeNvidia(fakeIo({ platform: "linux", files: { "/dev/nvidiactl": "" } }));
    expect(r.state).toBe("error");
    expect(r.detail).toContain("NVIDIA_DRIVER_CAPABILITIES");
  });
  test("driver not loaded: exit code explained", async () => {
    const io = fakeIo({ platform: "linux", commands: { "nvidia-smi": { missing: false, code: 9, stdout: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.", stderr: "", timedOut: false } } });
    const r = await probeNvidia(io);
    expect(r.state).toBe("error");
    expect(r.detail).toContain("結束碼 9");
    expect(r.detail).toContain("驅動程式沒有載入");
  });
  test("hung nvidia-smi", async () => {
    const r = await probeNvidia(fakeIo({ platform: "linux", commands: { "nvidia-smi": { missing: false, code: null, stdout: "", stderr: "", timedOut: true } } }));
    expect(r.state).toBe("error");
    expect(r.detail).toContain("沒有回應");
  });
});

/** An Intel iGPU at 00:02.0 as sysfs shows it, with one ffmpeg (pid 300) holding the render node. */
function intelSystem(fdinfo: string, opts: { devDri?: boolean } = {}) {
  return fakeIo({
    platform: "linux",
    files: {
      "/sys/class/drm/card0/device/vendor": "0x8086\n",
      "/sys/class/drm/card0/device/device": "0x46a6\n",
      "/sys/class/drm/card0/device/drm/renderD128/dev": "226:128\n",
      ...(opts.devDri === false ? {} : { "/dev/dri/renderD128": "" }),
      "/proc/300/fdinfo/5": fdinfo,
      "/proc/300/fdinfo/6": "pos: 0\n",
    },
    links: {
      "/sys/class/drm/card0/device": "/sys/devices/pci0000:00/0000:00:02.0",
      "/sys/class/drm/card0/device/driver": "/sys/bus/pci/drivers/i915",
      "/sys/class/drm/card0-HDMI-A-1": "/sys/devices/x",
      "/proc/300/fd/5": "/dev/dri/renderD128",
      "/proc/300/fd/6": "socket:[123]",
    },
  });
}

describe("Intel", () => {
  test("utilisation from fdinfo deltas of our own processes", async () => {
    const probe = createIntelProbe();
    const first = await probe.probe(intelSystem(await fixture("i915-fdinfo-a.txt")), 0);
    expect(first.state).toBe("ok");
    expect(first.gpus[0]!.name).toBe("Intel 內顯");
    expect(first.gpus[0]!.id).toBe("intel:0000:00:02.0");
    expect(first.gpus[0]!.utilPct).toBeNull();
    const second = await probe.probe(intelSystem(await fixture("i915-fdinfo-b.txt")), 5e9);
    expect(second.gpus[0]!.utilPct).toBeCloseTo(40);
    expect(second.gpus[0]!.detail).toContain("驅動 i915");
  });
  test("an idle GPU nobody uses reads 0 %, not unknown", async () => {
    const probe = createIntelProbe();
    const idle = intelSystem("");
    await probe.probe(idle, 0);
    expect((await probe.probe(idle, 5e9)).gpus[0]!.utilPct).toBe(0);
  });
  test("card visible in sysfs but /dev/dri not passed to the container", async () => {
    const r = await createIntelProbe().probe(intelSystem("", { devDri: false }), 0);
    expect(r.state).toBe("error");
    expect(r.detail).toContain("/dev/dri");
  });
  test("no Intel card", async () => {
    const r = await createIntelProbe().probe(fakeIo({ platform: "linux", files: { "/sys/class/drm/card0/device/vendor": "0x10de\n" } }), 0);
    expect(r.state).toBe("absent");
  });
});

describe("Apple", () => {
  test("ioreg on macOS", async () => {
    const r = await probeApple(fakeIo({ platform: "darwin", commands: { ioreg: ok(await fixture("macos-ioreg.txt")) } }));
    expect(r.state).toBe("ok");
    expect(r.gpus[0]!.name).toBe("Apple M5 Pro 內建 GPU");
  });
  test("skipped on Linux without running anything", async () => {
    const io = fakeIo({ platform: "linux" });
    expect((await probeApple(io)).state).toBe("absent");
    expect(io.ran).toEqual([]);
  });
});
