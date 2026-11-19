import { expect, test } from "bun:test";
import { eligibility, parseProbe } from "./check";

const probe = (codec: string, keyTimes: number[], audio: string | null = "pcm_alaw") => ({
  streams: [
    { index: 0, codec_type: "video", codec_name: codec, width: 2560, height: 1440 },
    ...(audio ? [{ index: 1, codec_type: "audio", codec_name: audio }] : []),
  ],
  packets: [
    ...keyTimes.flatMap((t) => [
      { stream_index: 0, pts_time: String(t), flags: "K__" },
      { stream_index: 0, pts_time: String(t + 0.5), flags: "___" },
      { stream_index: 1, pts_time: String(t), flags: "K__" },
    ]),
  ],
});

test("reads codec, size, audio and the keyframe interval of a Tapo-like stream", () => {
  const c = parseProbe(probe("h264", [0.1, 2.1, 4.1, 6.1]), 5);
  expect(c).toEqual({ at: 5, videoCodec: "h264", width: 2560, height: 1440, audioCodec: "pcm_alaw", keyframeIntervalSec: 2 });
  expect(eligibility(c)).toEqual({ ok: true, warning: null });
});

test("audio keyframes do not count toward the video keyframe interval", () => {
  expect(parseProbe(probe("h264", [0, 3]), 0).keyframeIntervalSec).toBe(3);
});

test("H.265 cameras are refused", () => {
  expect(eligibility(parseProbe(probe("hevc", [0, 2]), 0))).toEqual({ ok: false, reason: "not-h264" });
});

test("a keyframe interval over 4 s, or one too long to measure, is a warning", () => {
  expect(eligibility(parseProbe(probe("h264", [0, 5]), 0))).toEqual({ ok: true, warning: "keyframe-interval" });
  const single = parseProbe(probe("h264", [0]), 0);
  expect(single.keyframeIntervalSec).toBeNull();
  expect(eligibility(single)).toEqual({ ok: true, warning: "keyframe-interval" });
});

test("no video stream at all", () => {
  expect(eligibility(parseProbe({ streams: [], packets: [] }, 0))).toEqual({ ok: false, reason: "no-video" });
  expect(parseProbe(probe("h264", [0, 2], null), 0).audioCodec).toBeNull();
});
