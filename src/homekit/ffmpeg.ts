/**
 * ffmpeg command lines for the hksv-stream workers. Both read the restream's main stream and copy
 * the video untouched; only audio is transcoded. `-progress pipe:1` gives the supervisor a
 * line every second to judge stalls by.
 */
import type { LiveTarget, RecordAudio } from "./protocol.ts";

const INPUT = (url: string) => [
  ...["-hide_banner", "-nostdin", "-loglevel", "warning", "-progress", "pipe:1", "-stats_period", "1"],
  ...["-fflags", "nobuffer", "-probesize", "500000", "-analyzeduration", "500000"],
  ...["-rtsp_transport", "tcp", "-timeout", "10000000"],
  ...["-i", url],
];

function srtpUrl(t: LiveTarget, port: number, pktSize: number): string {
  const host = t.ipv6 ? `[${t.address}]` : t.address;
  return `srtp://${host}:${port}?rtcpport=${port}&pkt_size=${pktSize}`;
}

/** Live view in the Home app: SRTP straight to the iPhone, video copied, audio as Opus. */
export function liveCommand(ffmpegBin: string, url: string, t: LiveTarget): string[] {
  const srtp = (params: string) => ["-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80", "-srtp_out_params", params];
  const cmd = [
    ffmpegBin,
    ...INPUT(url),
    // The phone only gets SPS/PPS in-band; dump_extra repeats them before every keyframe.
    ...["-map", "0:v:0", "-c:v", "copy", "-bsf:v", "dump_extra", "-an"],
    ...["-payload_type", String(t.video.payloadType), "-ssrc", String(t.video.ssrc), "-f", "rtp"],
    ...srtp(t.video.srtp),
    srtpUrl(t, t.video.port, t.video.mtu),
  ];
  if (t.audio) {
    const a = t.audio;
    cmd.push(
      ...["-map", "0:a:0", "-vn", "-c:a", "libopus", "-application", "lowdelay", "-frame_duration", String(a.packetTimeMs)],
      ...["-ar", String(a.sampleRateKhz * 1000), "-ac", "1", "-b:a", `${a.bitrateKbps}k`],
      ...["-payload_type", String(a.payloadType), "-ssrc", String(a.ssrc), "-f", "rtp"],
      ...srtp(a.srtp),
      srtpUrl(t, a.port, 188),
    );
  }
  return cmd;
}

/**
 * HomeKit Secure Video source: fMP4 to the homekit worker, one fragment per keyframe so every
 * fragment starts with one, as HKSV requires.
 */
export function recordCommand(ffmpegBin: string, url: string, port: number, audio: RecordAudio | null): string[] {
  return [
    ffmpegBin,
    ...INPUT(url),
    ...["-map", "0:v:0", "-c:v", "copy"],
    ...(audio
      ? ["-map", "0:a:0?", "-c:a", "aac", "-profile:a", "aac_low", "-ar", String(audio.sampleRateHz), "-ac", String(audio.channels), "-b:a", `${audio.bitrateKbps}k`]
      : ["-an"]),
    ...["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"],
    `tcp://127.0.0.1:${port}`,
  ];
}
