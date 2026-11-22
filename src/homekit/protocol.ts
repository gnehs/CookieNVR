/**
 * Messages between the main process and the homekit worker: newline-delimited JSON over a
 * loopback TCP connection the main process listens on. The worker proves itself with the token it
 * got in its environment. Main never loads HAP-NodeJS; the worker never sees camera credentials
 * (main builds every ffmpeg command line from the sessions the worker asks for).
 */
import type { HomekitIdentity } from "./identity.ts";

export interface AccessoryConfig {
  id: string;
  name: string;
  identity: HomekitIdentity;
  /** Send audio to HomeKit (the main stream has audio and the camera records sound). */
  audio: boolean;
  motion: boolean;
}

export type ToWorker =
  | { type: "config"; cameras: AccessoryConfig[] }
  | { type: "motion"; cameraId: string; active: boolean }
  | { type: "snapshot"; reqId: number; jpeg: string | null }
  /** Unpublish and delete this accessory's pairing data. */
  | { type: "forget"; cameraId: string; reqId: number }
  /** The ffmpeg behind a session could not run; the worker ends the HomeKit session. */
  | { type: "session-failed"; sessionId: string; error: string };

export type RequestKind = "snapshot" | "live" | "recording";

export interface RequestLog {
  at: number;
  ok: boolean;
  /** Short English detail for diagnostics, e.g. "640x360, 42 KB" or the error. */
  detail: string;
}

export interface AccessoryStatus {
  id: string;
  published: boolean;
  paired: boolean;
  /** Why publishing failed, e.g. the port is in use. */
  error: string | null;
  recording: { active: boolean; configured: boolean; prebufferMs: number; streaming: boolean };
  requests: Partial<Record<RequestKind, RequestLog>>;
}

export interface LiveTarget {
  address: string;
  ipv6: boolean;
  video: { port: number; ssrc: number; payloadType: number; mtu: number; srtp: string };
  audio: { port: number; ssrc: number; payloadType: number; srtp: string; sampleRateKhz: number; bitrateKbps: number; packetTimeMs: number } | null;
}

export interface RecordAudio {
  sampleRateHz: number;
  bitrateKbps: number;
  channels: number;
}

export type StreamSession =
  | { id: string; cameraId: string; kind: "live"; target: LiveTarget }
  /** `port`: where the worker accepts this camera's recording fMP4 on 127.0.0.1. */
  | { id: string; cameraId: string; kind: "record"; port: number; audio: RecordAudio | null };

export type FromWorker =
  | { type: "hello"; token: string }
  /** Sent on every change and every 2 s; doubles as the heartbeat. */
  | { type: "status"; cameras: AccessoryStatus[]; sessions: StreamSession[] }
  | { type: "snapshot"; reqId: number; cameraId: string }
  | { type: "forgotten"; reqId: number };

export function encode(msg: ToWorker | FromWorker): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Bun sockets do not buffer: write() reports how many bytes it took and drops the rest. A snapshot reply is
 * hundreds of kilobytes, so a line cut short would run into the next one and both would be lost.
 */
export class SocketWriter {
  private unsent: Uint8Array | null = null;

  constructor(private readonly socket: { write(data: Uint8Array): number }) {}

  write(text: string): void {
    this.push(new TextEncoder().encode(text));
  }

  /** Call from the socket's `drain` handler. */
  drain(): void {
    const rest = this.unsent;
    if (!rest) return;
    this.unsent = null;
    this.push(rest);
  }

  private push(bytes: Uint8Array): void {
    if (this.unsent) {
      const merged = new Uint8Array(this.unsent.length + bytes.length);
      merged.set(this.unsent);
      merged.set(bytes, this.unsent.length);
      this.unsent = merged;
      return;
    }
    const n = this.socket.write(bytes);
    if (n < bytes.length) this.unsent = bytes.slice(Math.max(0, n));
  }
}

/** Splits a byte stream into lines; keeps an unterminated tail for the next chunk. */
export class LineReader {
  private partial = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly maxLine = 4 * 1024 * 1024) {}

  push(chunk: Uint8Array): string[] {
    const parts = (this.partial + this.decoder.decode(chunk, { stream: true })).split("\n");
    this.partial = parts.pop() ?? "";
    if (this.partial.length > this.maxLine) throw new Error("control line too long");
    return parts.filter((l) => l.length > 0);
  }
}

type Obj = Record<string, unknown>;

class ParseError extends Error {}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ParseError(`${path}: expected object`);
  return v as Obj;
}
function str(o: Obj, k: string): string {
  if (typeof o[k] !== "string") throw new ParseError(`${k}: expected string`);
  return o[k] as string;
}
function num(o: Obj, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ParseError(`${k}: expected number`);
  return v;
}
function port(o: Obj, k: string): number {
  const v = num(o, k);
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new ParseError(`${k}: expected port`);
  return v;
}
function bool(o: Obj, k: string): boolean {
  if (typeof o[k] !== "boolean") throw new ParseError(`${k}: expected boolean`);
  return o[k] as boolean;
}
function arr(o: Obj, k: string): unknown[] {
  if (!Array.isArray(o[k])) throw new ParseError(`${k}: expected array`);
  return o[k] as unknown[];
}

function parseIdentity(v: unknown): HomekitIdentity {
  const o = obj(v, "identity");
  return { username: str(o, "username"), pincode: str(o, "pincode"), setupId: str(o, "setupId"), port: port(o, "port") };
}

function parseRequests(v: unknown): AccessoryStatus["requests"] {
  const o = obj(v, "requests");
  const out: AccessoryStatus["requests"] = {};
  for (const k of ["snapshot", "live", "recording"] as const) {
    if (o[k] === undefined) continue;
    const r = obj(o[k], k);
    out[k] = { at: num(r, "at"), ok: bool(r, "ok"), detail: str(r, "detail") };
  }
  return out;
}

function parseStatus(v: unknown): AccessoryStatus {
  const o = obj(v, "camera");
  const r = obj(o.recording, "recording");
  return {
    id: str(o, "id"),
    published: bool(o, "published"),
    paired: bool(o, "paired"),
    error: o.error === null ? null : str(o, "error"),
    recording: { active: bool(r, "active"), configured: bool(r, "configured"), prebufferMs: num(r, "prebufferMs"), streaming: bool(r, "streaming") },
    requests: parseRequests(o.requests),
  };
}

function parseLiveTarget(v: unknown): LiveTarget {
  const o = obj(v, "target");
  const vi = obj(o.video, "video");
  const srtp = (x: Obj) => {
    const s = str(x, "srtp");
    if (!/^[A-Za-z0-9+/]+=*$/.test(s)) throw new ParseError("srtp: expected base64");
    return s;
  };
  const address = str(o, "address");
  if (!/^[0-9A-Fa-f.:]+$/.test(address)) throw new ParseError("address: expected an IP address");
  let audio: LiveTarget["audio"] = null;
  if (o.audio !== null) {
    const a = obj(o.audio, "audio");
    audio = {
      port: port(a, "port"), ssrc: num(a, "ssrc"), payloadType: num(a, "payloadType"), srtp: srtp(a),
      sampleRateKhz: num(a, "sampleRateKhz"), bitrateKbps: num(a, "bitrateKbps"), packetTimeMs: num(a, "packetTimeMs"),
    };
  }
  return {
    address,
    ipv6: bool(o, "ipv6"),
    video: { port: port(vi, "port"), ssrc: num(vi, "ssrc"), payloadType: num(vi, "payloadType"), mtu: num(vi, "mtu"), srtp: srtp(vi) },
    audio,
  };
}

function parseSession(v: unknown): StreamSession {
  const o = obj(v, "session");
  const id = str(o, "id");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new ParseError("session id: unexpected characters");
  const cameraId = str(o, "cameraId");
  const kind = str(o, "kind");
  if (kind === "live") return { id, cameraId, kind, target: parseLiveTarget(o.target) };
  if (kind === "record") {
    let audio: RecordAudio | null = null;
    if (o.audio !== null) {
      const a = obj(o.audio, "audio");
      audio = { sampleRateHz: num(a, "sampleRateHz"), bitrateKbps: num(a, "bitrateKbps"), channels: num(a, "channels") };
    }
    return { id, cameraId, kind, port: port(o, "port"), audio };
  }
  throw new ParseError(`unknown session kind ${kind}`);
}

/** Throws on anything malformed; the main process drops the connection then. */
export function parseFromWorker(line: string): FromWorker {
  const o = obj(JSON.parse(line), "message");
  switch (o.type) {
    case "hello":
      return { type: "hello", token: str(o, "token") };
    case "status":
      return { type: "status", cameras: arr(o, "cameras").map(parseStatus), sessions: arr(o, "sessions").map(parseSession) };
    case "snapshot":
      return { type: "snapshot", reqId: num(o, "reqId"), cameraId: str(o, "cameraId") };
    case "forgotten":
      return { type: "forgotten", reqId: num(o, "reqId") };
    default:
      throw new ParseError(`unknown message type ${String(o.type)}`);
  }
}

export function parseToWorker(line: string): ToWorker {
  const o = obj(JSON.parse(line), "message");
  switch (o.type) {
    case "config":
      return {
        type: "config",
        cameras: arr(o, "cameras").map((c) => {
          const x = obj(c, "camera");
          return { id: str(x, "id"), name: str(x, "name"), identity: parseIdentity(x.identity), audio: bool(x, "audio"), motion: bool(x, "motion") };
        }),
      };
    case "motion":
      return { type: "motion", cameraId: str(o, "cameraId"), active: bool(o, "active") };
    case "snapshot":
      return { type: "snapshot", reqId: num(o, "reqId"), jpeg: o.jpeg === null ? null : str(o, "jpeg") };
    case "forget":
      return { type: "forget", cameraId: str(o, "cameraId"), reqId: num(o, "reqId") };
    case "session-failed":
      return { type: "session-failed", sessionId: str(o, "sessionId"), error: str(o, "error") };
    default:
      throw new ParseError(`unknown message type ${String(o.type)}`);
  }
}
