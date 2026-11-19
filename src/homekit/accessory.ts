/**
 * One CookieNVR camera as a standalone HomeKit accessory (worker side only; loads HAP-NodeJS).
 * Live view and HKSV recording ffmpeg processes are not spawned here: the accessory publishes the
 * sessions it needs and the main process runs them as supervised hksv-stream workers.
 */
import dgram from "node:dgram";
import type * as HAP from "hap-nodejs";
import type { Socket, TCPSocketListener } from "bun";
import { Mp4Splitter } from "../../web/playback/mp4.ts";
import { Prebuffer, type RecordingStream } from "./fragments.ts";
import { jpegSize, scaleJpeg } from "./jpeg.ts";
import type { AccessoryConfig, AccessoryStatus, LiveTarget, RecordAudio, RequestKind, StreamSession } from "./protocol.ts";

type Hap = typeof HAP;

// HAP-NodeJS exports these as const enums, which this project's isolated module setup cannot read.
const PROFILE = { BASELINE: 0 as HAP.H264Profile, MAIN: 1 as HAP.H264Profile, HIGH: 2 as HAP.H264Profile };
const LEVEL = { L3_1: 0 as HAP.H264Level, L3_2: 1 as HAP.H264Level, L4_0: 2 as HAP.H264Level };
const SRTP_AES_CM_128 = 0 as HAP.SRTPCryptoSuites;
const OPUS = "OPUS" as HAP.AudioStreamingCodecType;
const FRAGMENTED_MP4 = 0 as HAP.MediaContainerType;
const VIDEO_H264 = 0 as HAP.VideoCodecType;
const AAC_LC = 0 as HAP.AudioRecordingCodecType;
const REC_RATE = { KHZ_16: 1 as HAP.AudioRecordingSamplerate, KHZ_24: 2 as HAP.AudioRecordingSamplerate, KHZ_32: 3 as HAP.AudioRecordingSamplerate };
const REC_RATE_HZ = [8000, 16000, 24000, 32000, 44100, 48000];
const IP_CAMERA = 17 as HAP.Categories;

export const PREBUFFER_MS = 4_000;
const FRAGMENT_MS = 4_000;
/** One recording stream may fall this far behind before it is cut off. */
const MAX_STREAM_BACKLOG = 16 * 1024 * 1024;
/** The phone sends RTCP receiver reports about every second; silence this long means it left. */
const RTCP_TIMEOUT_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;

const RESOLUTIONS: [number, number, number][] = [
  [1920, 1080, 30], [1280, 720, 30], [640, 360, 30], [480, 270, 30], [320, 180, 30],
  [1600, 1200, 30], [1280, 960, 30], [1024, 768, 30], [640, 480, 30], [480, 360, 30], [320, 240, 15],
];

export interface AccessoryDeps {
  hap: Hap;
  ffmpegBin: string;
  version: string;
  /** The newest snapshot from the main process, or null. */
  snapshot(cameraId: string): Promise<Uint8Array | null>;
  /** Status or sessions changed. */
  changed(): void;
  log(message: string): void;
}

interface LiveSession {
  target: LiveTarget;
  sockets: dgram.Socket[];
  lastRtcp: number;
  watchdog: ReturnType<typeof setInterval> | null;
  started: boolean;
}

type RecordServer = { listener: TCPSocketListener<{ splitter: Mp4Splitter }>; current: Socket<{ splitter: Mp4Splitter }> | null };

export class CameraAccessory {
  readonly accessory: HAP.Accessory;
  private readonly controller: HAP.CameraController;
  private readonly prebuffer = new Prebuffer(PREBUFFER_MS);
  private readonly live = new Map<string, LiveSession>();
  private readonly streams = new Map<number, RecordingStream>();
  private recordingActive = false;
  private recordingConfig: HAP.CameraRecordingConfiguration | undefined;
  private recordServer: RecordServer | null = null;
  private recordAudio: RecordAudio | null = null;
  private published = false;
  private closing: Promise<void> | null = null;
  private error: string | null = null;
  private readonly requests: AccessoryStatus["requests"] = {};
  private lastSnapshot: { source: Uint8Array; width: number; height: number; out: Uint8Array } | null = null;

  constructor(
    private config: AccessoryConfig,
    private readonly deps: AccessoryDeps,
  ) {
    const { hap } = deps;
    const acc = new hap.Accessory(config.name, hap.uuid.generate(`cookienvr:${config.identity.username}`));
    acc.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, "CookieNVR")
      .setCharacteristic(hap.Characteristic.Model, "CookieNVR Camera")
      .setCharacteristic(hap.Characteristic.SerialNumber, config.id)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, deps.version);
    this.controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: {
        handleSnapshotRequest: (req, cb) => void this.handleSnapshot(req).then((b) => cb(undefined, Buffer.from(b)), (e: Error) => cb(e)),
        prepareStream: (req, cb) => void this.prepareStream(req).then((r) => cb(undefined, r), (e: Error) => cb(e)),
        handleStreamRequest: (req, cb) => {
          this.handleStreamRequest(req);
          cb();
        },
      },
      streamingOptions: {
        supportedCryptoSuites: [SRTP_AES_CM_128],
        video: { codec: { profiles: [PROFILE.BASELINE, PROFILE.MAIN, PROFILE.HIGH], levels: [LEVEL.L3_1, LEVEL.L3_2, LEVEL.L4_0] }, resolutions: RESOLUTIONS },
        audio: { twoWayAudio: false, codecs: [{ type: OPUS, samplerate: [16 as HAP.AudioStreamingSamplerate, 24 as HAP.AudioStreamingSamplerate] }] },
      },
      recording: {
        options: {
          prebufferLength: PREBUFFER_MS,
          mediaContainerConfiguration: [{ type: FRAGMENTED_MP4, fragmentLength: FRAGMENT_MS }],
          video: {
            type: VIDEO_H264,
            parameters: { profiles: [PROFILE.MAIN, PROFILE.HIGH], levels: [LEVEL.L3_1, LEVEL.L3_2, LEVEL.L4_0] },
            resolutions: RESOLUTIONS.filter(([, , fps]) => fps === 30),
          },
          audio: { codecs: [{ type: AAC_LC, audioChannels: 1, samplerate: [REC_RATE.KHZ_16, REC_RATE.KHZ_24, REC_RATE.KHZ_32] }] },
        },
        delegate: {
          updateRecordingActive: (active) => {
            this.recordingActive = active;
            void this.syncRecording();
          },
          updateRecordingConfiguration: (c) => {
            this.recordingConfig = c;
            void this.syncRecording();
          },
          handleRecordingStreamRequest: (streamId, signal) => this.recordingStream(streamId, signal),
          closeRecordingStream: (streamId, reason) => {
            this.streams.get(streamId)?.end("closed");
            this.deps.log(`${this.config.id}: recording stream ${streamId} closed (reason ${reason ?? "connection closed"})`);
          },
          acknowledgeStream: (streamId) => this.streams.get(streamId)?.end("closed"),
        },
      },
      sensors: { motion: true },
    });
    acc.configureController(this.controller);
    this.controller.recordingManagement?.recordingManagementService
      .getCharacteristic(hap.Characteristic.RecordingAudioActive)
      .on("change", () => void this.syncRecording());
    acc.on("paired" as never, () => deps.changed());
    acc.on("unpaired" as never, () => deps.changed());
    this.accessory = acc;
    this.setMotion(config.motion);
  }

  get id(): string {
    return this.config.id;
  }

  get identity() {
    return this.config.identity;
  }

  async publish(): Promise<void> {
    const { identity } = this.config;
    try {
      await this.accessory.publish({
        username: identity.username,
        pincode: identity.pincode,
        setupID: identity.setupId,
        port: identity.port,
        category: IP_CAMERA,
        advertiser: "ciao" as HAP.MDNSAdvertiser,
        addIdentifyingMaterial: false,
      });
      this.published = true;
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
      this.deps.log(`${this.config.id}: publish failed: ${this.error}`);
    }
    this.deps.changed();
  }

  /** Name, audio and motion can change in place; a new identity needs a new accessory. */
  update(config: AccessoryConfig): void {
    const audioChanged = config.audio !== this.config.audio;
    this.config = config;
    this.setMotion(config.motion);
    if (audioChanged) void this.syncRecording();
  }

  setMotion(active: boolean): void {
    this.config = { ...this.config, motion: active };
    this.controller.motionService?.getCharacteristic(this.deps.hap.Characteristic.MotionDetected).updateValue(active);
  }

  /**
   * Stops everything; `forget` also deletes the pairing data (reset pairing). Idempotent: a second
   * concurrent unpublish would let the process exit before ciao has sent its mDNS goodbye.
   */
  close(forget: boolean): Promise<void> {
    this.closing ??= (async () => {
      for (const id of [...this.live.keys()]) this.endLive(id);
      this.stopRecordServer();
      await (forget ? this.accessory.destroy() : this.accessory.unpublish());
      this.published = false;
    })();
    return this.closing;
  }

  sessions(): StreamSession[] {
    const out: StreamSession[] = [];
    for (const [id, s] of this.live) if (s.started) out.push({ id, cameraId: this.config.id, kind: "live", target: s.target });
    if (this.recordServer) {
      out.push({ id: `rec-${this.config.id}`, cameraId: this.config.id, kind: "record", port: this.recordServer.listener.port, audio: this.recordAudio });
    }
    return out;
  }

  status(): AccessoryStatus {
    const info = (this.accessory as unknown as { _accessoryInfo?: { paired(): boolean } })._accessoryInfo;
    return {
      id: this.config.id,
      published: this.published,
      paired: info?.paired() ?? false,
      error: this.error,
      recording: {
        active: this.recordingActive,
        configured: this.recordingConfig !== undefined,
        prebufferMs: Math.round(this.prebuffer.bufferedMs),
        streaming: this.streams.size > 0,
      },
      requests: { ...this.requests },
    };
  }

  /** The main process could not run a session's ffmpeg. */
  sessionFailed(sessionId: string, error: string): void {
    if (this.live.has(sessionId)) {
      this.note("live", false, error);
      this.controller.forceStopStreamingSession(sessionId);
      this.endLive(sessionId);
    } else if (sessionId === `rec-${this.config.id}`) {
      this.note("recording", false, `ffmpeg: ${error}`);
    }
  }

  private note(kind: RequestKind, ok: boolean, detail: string): void {
    this.requests[kind] = { at: Date.now(), ok, detail };
    this.deps.changed();
  }

  private async handleSnapshot(req: HAP.SnapshotRequest): Promise<Uint8Array> {
    const size = `${req.width}x${req.height}`;
    try {
      const source = await Promise.race([
        this.deps.snapshot(this.config.id),
        Bun.sleep(SNAPSHOT_TIMEOUT_MS).then(() => null),
      ]);
      if (!source) throw new Error("no snapshot available yet");
      const cached = this.lastSnapshot;
      let out: Uint8Array;
      if (cached && Buffer.from(cached.source).equals(source) && cached.width === req.width && cached.height === req.height) out = cached.out;
      else {
        const dims = jpegSize(source);
        out = dims?.width === req.width && dims.height === req.height ? source : await scaleJpeg(this.deps.ffmpegBin, source, req.width, req.height);
        this.lastSnapshot = { source, width: req.width, height: req.height, out };
      }
      this.note("snapshot", true, `${size}, ${Math.round(out.length / 1024)} KB`);
      return out;
    } catch (e) {
      this.note("snapshot", false, `${size}: ${(e as Error).message}`);
      throw e;
    }
  }

  private async bindRtcp(ipv6: boolean, onPacket: () => void): Promise<dgram.Socket> {
    const socket = dgram.createSocket(ipv6 ? "udp6" : "udp4");
    socket.on("message", onPacket);
    socket.on("error", (e) => this.deps.log(`${this.config.id}: rtcp socket: ${e.message}`));
    await new Promise<void>((resolve) => socket.bind(0, resolve));
    return socket;
  }

  private async prepareStream(req: HAP.PrepareStreamRequest): Promise<HAP.PrepareStreamResponse> {
    const ipv6 = req.addressVersion === "ipv6";
    const session: LiveSession = {
      target: undefined as unknown as LiveTarget,
      sockets: [],
      lastRtcp: Date.now(),
      watchdog: null,
      started: false,
    };
    const touch = () => (session.lastRtcp = Date.now());
    const video = await this.bindRtcp(ipv6, touch);
    const audio = this.config.audio ? await this.bindRtcp(ipv6, touch) : null;
    session.sockets = audio ? [video, audio] : [video];
    const { hap } = this.deps;
    const videoSsrc = hap.CameraController.generateSynchronisationSource();
    const audioSsrc = hap.CameraController.generateSynchronisationSource();
    const srtp = (s: HAP.Source) => Buffer.concat([s.srtp_key, s.srtp_salt]).toString("base64");
    session.target = {
      address: req.targetAddress,
      ipv6,
      video: { port: req.video.port, ssrc: videoSsrc, payloadType: 99, mtu: 1378, srtp: srtp(req.video) },
      audio: audio ? { port: req.audio.port, ssrc: audioSsrc, payloadType: 110, srtp: srtp(req.audio), sampleRateKhz: 16, bitrateKbps: 24, packetTimeMs: 20 } : null,
    };
    this.live.set(req.sessionID, session);
    return {
      video: { port: video.address().port, ssrc: videoSsrc, srtp_key: req.video.srtp_key, srtp_salt: req.video.srtp_salt },
      audio: audio ? { port: audio.address().port, ssrc: audioSsrc, srtp_key: req.audio.srtp_key, srtp_salt: req.audio.srtp_salt } : undefined,
    };
  }

  private handleStreamRequest(req: HAP.StreamingRequest): void {
    const session = this.live.get(req.sessionID);
    if (req.type === ("start" as HAP.StreamRequestTypes.START)) {
      if (!session) return;
      const v = req.video;
      session.target.video = { ...session.target.video, payloadType: v.pt, mtu: v.mtu };
      const a = req.audio;
      if (session.target.audio && a && a.codec === OPUS) {
        session.target.audio = {
          ...session.target.audio,
          payloadType: a.pt,
          sampleRateKhz: a.sample_rate,
          bitrateKbps: Math.max(16, a.max_bit_rate || 24),
          packetTimeMs: a.packet_time || 20,
        };
      } else session.target.audio = null;
      session.started = true;
      session.lastRtcp = Date.now();
      session.watchdog = setInterval(() => {
        if (Date.now() - session.lastRtcp < RTCP_TIMEOUT_MS) return;
        this.note("live", false, "no RTCP from the viewer for 30 s, stopped");
        this.controller.forceStopStreamingSession(req.sessionID);
        this.endLive(req.sessionID);
      }, 5_000);
      this.note("live", true, `started for ${session.target.address}, requested ${v.width}x${v.height}@${v.fps} ${v.max_bit_rate} kbps, sending source as-is`);
    } else if (req.type === ("stop" as HAP.StreamRequestTypes.STOP)) {
      if (session?.started) this.note("live", true, "stopped by the viewer");
      this.endLive(req.sessionID);
    }
  }

  private endLive(id: string): void {
    const s = this.live.get(id);
    if (!s) return;
    this.live.delete(id);
    if (s.watchdog) clearInterval(s.watchdog);
    for (const sock of s.sockets) sock.close();
    this.deps.changed();
  }

  private wantedRecordAudio(): RecordAudio | null {
    const c = this.recordingConfig;
    const audioActive = this.controller.recordingManagement?.recordingManagementService
      .getCharacteristic(this.deps.hap.Characteristic.RecordingAudioActive).value;
    if (!c || !this.config.audio || audioActive !== 1) return null;
    return { sampleRateHz: REC_RATE_HZ[c.audioCodec.samplerate] ?? 16000, bitrateKbps: c.audioCodec.bitrate || 32, channels: c.audioCodec.audioChannels ?? 1 };
  }

  /** Runs the recording source while HomeKit wants recordings, with the selected audio settings. */
  private async syncRecording(): Promise<void> {
    const want = this.recordingActive && this.recordingConfig !== undefined;
    const audio = want ? this.wantedRecordAudio() : null;
    if (!want) {
      if (this.recordServer) this.stopRecordServer();
      return;
    }
    if (this.recordServer && JSON.stringify(audio) === JSON.stringify(this.recordAudio)) return;
    this.recordAudio = audio;
    if (!this.recordServer) this.startRecordServer();
    // A changed audio setting changes the session, so the main process restarts its ffmpeg.
    this.deps.changed();
  }

  private startRecordServer(): void {
    const prebuffer = this.prebuffer;
    const server: RecordServer = {
      current: null,
      listener: Bun.listen<{ splitter: Mp4Splitter }>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open: (sock) => {
            server.current?.end();
            server.current = sock;
            sock.data = { splitter: new Mp4Splitter() };
          },
          data: (sock, chunk) => {
            if (server.current !== sock) return;
            for (const unit of sock.data.splitter.push(chunk)) {
              if (unit.kind === "init") prebuffer.setInit(unit.bytes);
              else prebuffer.push({ bytes: unit.bytes, durationMs: unit.time ? (unit.time.end - unit.time.start) * 1000 : 0 });
            }
          },
          close: (sock) => {
            if (server.current === sock) server.current = null;
          },
        },
      }),
    };
    this.recordServer = server;
  }

  private stopRecordServer(): void {
    if (!this.recordServer) return;
    this.recordServer.current?.end();
    this.recordServer.listener.stop(true);
    this.recordServer = null;
    this.recordAudio = null;
    this.prebuffer.reset();
    this.deps.changed();
  }

  private async *recordingStream(streamId: number, signal?: AbortSignal): AsyncGenerator<HAP.RecordingPacket> {
    const stream = this.prebuffer.open(MAX_STREAM_BACKLOG);
    if (!stream) {
      this.note("recording", false, "hub asked for a recording, but no video has arrived yet");
      return;
    }
    stream.setMaxFragmentMs(this.recordingConfig?.mediaContainerConfiguration.fragmentLength ?? FRAGMENT_MS);
    this.streams.set(streamId, stream);
    signal?.addEventListener("abort", () => stream.end("closed"));
    this.note("recording", true, `stream ${streamId} opened, prebuffer ${Math.round(this.prebuffer.bufferedMs)} ms`);
    try {
      for (;;) {
        const packet = await stream.next();
        if (!packet) break;
        yield { data: Buffer.from(packet), isLast: false };
      }
    } finally {
      this.streams.delete(streamId);
      const detail = `stream ${streamId} ended (${stream.endReason ?? "generator returned"}), ${stream.sentPackets} packets sent${stream.oversized ? `, ${stream.oversized} fragments longer than ${FRAGMENT_MS} ms` : ""}`;
      this.note("recording", stream.endReason === "closed", detail);
    }
  }
}
