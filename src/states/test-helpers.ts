import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import backboneModel from "../../detector/backbone-model.json";
import type { StreamMessage } from "../api-types.ts";
import { openDb } from "../db.ts";
import { DEFAULT_DETECT } from "../detect/config.ts";
import { toErrorResponse } from "../http/respond.ts";
import type { Camera, CameraId } from "../types.ts";
import { createStateClassification } from "./service.ts";
import * as store from "./store.ts";

export const cam = "cam1" as CameraId;
export const camera: Camera = {
  id: cam,
  position: 0,
  groupId: null,
  createdAt: 0,
  updatedAt: 0,
  config: {
    name: "車庫",
    enabled: true,
    connection: { type: "rtsp", mainUrl: "rtsp://x/y", transport: "tcp" },
    record: { enabled: false, audio: false, direct: false },
    detect: DEFAULT_DETECT,
  },
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

export const jsonFrame = (v: object) => frame(1, enc.encode(JSON.stringify(v)));

export function blobFrame(v: object, blob: Uint8Array): Uint8Array {
  const head = enc.encode(JSON.stringify(v));
  const body = new Uint8Array(4 + head.length + blob.length);
  new DataView(body.buffer).setUint32(0, head.length);
  body.set(head, 4);
  body.set(blob, 4 + head.length);
  return frame(3, body);
}

type Received = { kind: number; json: Record<string, unknown>; blob: Uint8Array | null };

/** 用 Bun 假裝成 classify.py：連上 socket、照協定收發 */
export async function fakeWorker(socketPath: string) {
  const received: Received[] = [];
  let buf = new Uint8Array(0);
  let closed = false;
  const client: Socket<undefined> = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        let p = 0;
        while (merged.length - p >= 5) {
          const len = new DataView(merged.buffer, p + 1, 4).getUint32(0);
          if (merged.length - p - 5 < len) break;
          const kind = merged[p]!;
          const payload = merged.slice(p + 5, p + 5 + len);
          if (kind === 3) {
            const n = new DataView(payload.buffer).getUint32(0);
            received.push({ kind, json: JSON.parse(dec.decode(payload.subarray(4, 4 + n))), blob: payload.slice(4 + n) });
          } else received.push({ kind, json: JSON.parse(dec.decode(payload)), blob: null });
          p += 5 + len;
        }
        buf = merged.slice(p);
      },
      close() {
        closed = true;
      },
    },
  });
  return {
    received,
    closed: () => closed,
    send: (bytes: Uint8Array) => client.write(bytes),
    ready: () => client.write(jsonFrame({ type: "status", state: "ready", backbone: "DINOv2-small (int8)", loadMs: 12 })),
    end: () => client.end(),
  };
}

type CallInit = { params?: Record<string, string>; query?: string; body?: BodyInit; json?: unknown; headers?: Record<string, string> };

/** 一個已訓練好（model.json 在）的感應器「鐵捲門」，類別 關／開 */
export function harness(o: { segments?: { path: string; startMs: number; endMs: number | null }[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "cnvr-states-"));
  const db = openDb(":memory:");
  const sensorId = store.newSensorId();
  store.insertSensor(db, {
    id: sensorId,
    cameraId: cam,
    config: { name: "鐵捲門", classes: ["關", "開"], crop: [0, 0, 1, 1], threshold: 0.8, intervalSec: 10, onMotion: true, enabled: true },
    createdAt: 1,
  });
  const dir = join(dataDir, "states", sensorId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "model.json"),
    JSON.stringify({ trainedAt: 1, classes: ["關", "開"], counts: { 關: 10, 開: 10 }, validation: null, trainMs: 5, backbone: { id: backboneModel.id, name: backboneModel.name } }),
  );
  const published: StreamMessage[] = [];
  const socketPath = join(mkdtempSync("/tmp/cnvr-"), "c.sock");
  const states = createStateClassification({
    db,
    env: { detectorPython: "python3", dataDir, ffmpegBin: "ffmpeg" },
    cameras: () => [camera],
    blocked: () => false,
    segments: () => o.segments ?? [{ path: "a.mp4", startMs: 0, endMs: 60_000 }],
    publish: (m) => published.push(m),
    onWorkersChanged: () => {},
    socketPath,
  });
  /** 直接呼叫 routes() 的 handler；丟出的錯誤照 HTTP 層的方式轉成回應 */
  const call = async (method: string, path: string, init: CallInit = {}) => {
    const route = states.routes().find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`no route ${method} ${path}`);
    const params = { id: sensorId, ...init.params };
    const url = new URL(`http://x${path.replace(/:(\w+)/g, (_, k: string) => params[k as keyof typeof params] ?? "")}${init.query ? `?${init.query}` : ""}`);
    const headers = { ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...init.headers };
    const body = init.json === undefined ? init.body : JSON.stringify(init.json);
    const req = new Request(url, { method, headers, body });
    try {
      return (await route.handler({ req, url, params, principal: null, ip: "127.0.0.1" })) as Response;
    } catch (e) {
      return toErrorResponse(e);
    }
  };
  const sensor = () => states.list().find((s) => s.id === sensorId)!;
  return { states, db, dataDir, socketPath, sensorId, dir, published, call, sensor, settle: () => Bun.sleep(30) };
}
