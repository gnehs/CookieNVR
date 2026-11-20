import { describe, expect, test } from "bun:test";
import type { CodecCheckDto, DecodeStatusDto, InferenceDeviceDto, VideoDeviceDto } from "../../../src/api-types.ts";
import type { CameraId } from "../../../src/types.ts";
import { decodeNote, decodeOptions } from "./decode-model.ts";

const ok: CodecCheckDto = { ok: true, ms: 100 };
const no = (reason: string): CodecCheckDto => ({ ok: false, reason, detail: "ffmpeg: boom" });
const card = (id: string, name: string, h264: CodecCheckDto, hevc: CodecCheckDto): VideoDeviceDto => ({ id, kind: "intel", name, pci: null, decode: { h264, hevc }, encode: { h264: ok, hevc: ok } });
const status = (cameras: DecodeStatusDto["cameras"], requested = "auto"): DecodeStatusDto => ({ requested, cameras, warning: null });

describe("decodeOptions", () => {
  test("auto and cpu come first, then every card", () => {
    const o = decodeOptions([card("intel:GPU.0", "Intel 內顯", ok, ok)], [], "auto");
    expect(o.map((x) => x.value)).toEqual(["auto", "cpu", "intel:GPU.0"]);
    expect(o[0]!.label).toBe("Auto (default)");
  });

  test("model name from the objects list wins", () => {
    const objs: InferenceDeviceDto[] = [{ id: "intel:GPU.0", kind: "intel", name: "Intel(R) UHD Graphics 630", pci: null }];
    expect(decodeOptions([card("intel:GPU.0", "Intel 內顯", ok, ok)], objs, "auto")[2]!.label).toBe("Intel UHD Graphics 630");
  });

  test("a card that cannot decode either codec is disabled and shows its reason", () => {
    const o = decodeOptions([card("a", "A", no("沒掛 /dev/dri"), no("沒掛 /dev/dri"))], [], "auto")[2]!;
    expect(o.disabled).toBe(true);
    expect(o.desc).toBe("沒掛 /dev/dri");
  });

  test("one unsupported codec stays selectable with a short note", () => {
    const o = decodeOptions([card("a", "A", ok, no("x"))], [], "auto")[2]!;
    expect(o.disabled).toBe(false);
    expect(o.desc).toBe("H.265 not supported");
  });

  test("a saved card that is gone gets a placeholder", () => {
    expect(decodeOptions([], [], "nvidia:x").at(-1)!.label).toContain("not found");
  });
});

describe("decodeNote", () => {
  const dev = [card("intel:GPU.0", "Intel 內顯", ok, ok)];
  test("confirmed card", () => {
    expect(decodeNote(status([{ cameraId: "c" as CameraId, device: "intel:GPU.0", confirmed: true, fallback: null }]), dev, [])).toEqual({ tone: "ok", text: "In use: Intel 內顯" });
  });
  test("fallback shows the reason only", () => {
    const n = decodeNote(status([{ cameraId: "c" as CameraId, device: null, confirmed: false, fallback: { reason: "這張卡不能解", detail: "secret ffmpeg text" } }]), dev, []);
    expect(n).toEqual({ tone: "warn", text: "這張卡不能解" });
  });
  test("cpu cameras", () => {
    expect(decodeNote(status([{ cameraId: "c" as CameraId, device: null, confirmed: false, fallback: null }]), dev, [])?.text).toBe("In use: CPU");
  });
  test("no cards and nothing running", () => {
    expect(decodeNote(status([]), [], [])?.tone).toBe("muted");
  });
});
