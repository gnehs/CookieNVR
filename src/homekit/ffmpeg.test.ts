import { expect, test } from "bun:test";
import { liveCommand, recordCommand } from "./ffmpeg";
import type { LiveTarget } from "./protocol";

const target: LiveTarget = {
  address: "192.168.1.20",
  ipv6: false,
  video: { port: 51000, ssrc: -12345, payloadType: 99, mtu: 1378, srtp: "a2V5c2FsdA==" },
  audio: { port: 51002, ssrc: 777, payloadType: 110, srtp: "YXVkaW8=", sampleRateKhz: 24, bitrateKbps: 24, packetTimeMs: 20 },
};

const after = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1];

test("live view copies video and sends Opus, each over SRTP to the viewer", () => {
  const cmd = liveCommand("ffmpeg", "rtsp://u:p@127.0.0.1:8554/cam/main", target);
  expect(cmd.join(" ")).toContain("-map 0:v:0 -c:v copy");
  expect(cmd).toContain("srtp://192.168.1.20:51000?rtcpport=51000&pkt_size=1378");
  expect(cmd).toContain("srtp://192.168.1.20:51002?rtcpport=51002&pkt_size=188");
  expect(after(cmd, "-c:a")).toBe("libopus");
  expect(after(cmd, "-ar")).toBe("24000");
  expect(cmd.filter((c) => c === "-srtp_out_params")).toHaveLength(2);
  expect(after(cmd, "-ssrc")).toBe("-12345");
  expect(after(cmd, "-progress")).toBe("pipe:1");
});

test("live view without audio has a single output; IPv6 targets are bracketed", () => {
  const cmd = liveCommand("ffmpeg", "rtsp://x", { ...target, ipv6: true, address: "fe80::1", audio: null });
  expect(cmd).not.toContain("libopus");
  expect(cmd.some((c) => c.startsWith("srtp://[fe80::1]:51000"))).toBe(true);
});

test("recording copies video, makes AAC-LC, and cuts one fragment per keyframe", () => {
  const cmd = recordCommand("ffmpeg", "rtsp://x", 40123, { sampleRateHz: 16000, bitrateKbps: 32, channels: 1 });
  expect(cmd.join(" ")).toContain("-map 0:v:0 -c:v copy");
  expect(after(cmd, "-profile:a")).toBe("aac_low");
  expect(after(cmd, "-movflags")).toBe("frag_keyframe+empty_moov+default_base_moof");
  expect(cmd.at(-1)).toBe("tcp://127.0.0.1:40123");
  expect(recordCommand("ffmpeg", "rtsp://x", 1, null)).toContain("-an");
});
