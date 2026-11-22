import { expect, test } from "bun:test";
import { encode, LineReader, parseFromWorker, parseToWorker, SocketWriter, type FromWorker } from "./protocol";

test("lines split across chunks come out whole", () => {
  const r = new LineReader();
  const text = encode({ type: "motion", cameraId: "abc", active: true }) + encode({ type: "forget", cameraId: "abc", reqId: 2 });
  const bytes = new TextEncoder().encode(text);
  const lines = [...r.push(bytes.subarray(0, 10)), ...r.push(bytes.subarray(10))];
  expect(lines.map(parseToWorker)).toEqual([
    { type: "motion", cameraId: "abc", active: true },
    { type: "forget", cameraId: "abc", reqId: 2 },
  ]);
});

test("a status message survives the round trip", () => {
  const msg: FromWorker = {
    type: "status",
    cameras: [{ id: "abc", published: true, paired: false, error: null, recording: { active: true, configured: true, prebufferMs: 4000, streaming: false }, requests: { snapshot: { at: 1, ok: true, detail: "640x360" } } }],
    sessions: [
      { id: "rec-abc", cameraId: "abc", kind: "record", port: 40000, audio: { sampleRateHz: 16000, bitrateKbps: 32, channels: 1 } },
      { id: "0b7d2f1e-aaaa", cameraId: "abc", kind: "live", target: { address: "10.0.0.2", ipv6: false, video: { port: 5000, ssrc: 1, payloadType: 99, mtu: 1378, srtp: "AAAA" }, audio: null } },
    ],
  };
  expect(parseFromWorker(encode(msg).trim())).toEqual(msg);
});

test("rejects values that would end up on an ffmpeg command line unchecked", () => {
  const live = (address: string, srtp = "AAAA") =>
    JSON.stringify({ type: "status", cameras: [], sessions: [{ id: "s1", cameraId: "abc", kind: "live", target: { address, ipv6: false, video: { port: 5000, ssrc: 1, payloadType: 99, mtu: 1378, srtp }, audio: null } }] });
  expect(() => parseFromWorker(live("10.0.0.2 -f null"))).toThrow();
  expect(() => parseFromWorker(live("10.0.0.2", "a b"))).toThrow();
  expect(() => parseFromWorker(JSON.stringify({ type: "status", cameras: [], sessions: [{ id: "x;y", cameraId: "abc", kind: "record", port: 1, audio: null }] }))).toThrow();
  expect(() => parseFromWorker(JSON.stringify({ type: "nope" }))).toThrow();
});

test("a line larger than the socket takes in one write still arrives whole", async () => {
  const line = `${"x".repeat(32 * 1024 * 1024)}\n`;
  let received = 0;
  let lastByte = 0;
  const done = Promise.withResolvers<void>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(_s, chunk) {
        received += chunk.length;
        lastByte = chunk[chunk.length - 1]!;
        if (received >= line.length) done.resolve();
      },
    },
  });
  let writer: SocketWriter | null = null;
  let firstWrite = -1;
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data() {}, drain: () => writer?.drain() },
  });
  writer = new SocketWriter({
    write(bytes) {
      const n = client.write(bytes);
      if (firstWrite < 0) firstWrite = n;
      return n;
    },
  });
  writer.write(line);
  await Promise.race([done.promise, Bun.sleep(5_000)]);
  client.end();
  server.stop(true);
  // the premise: one write does not take the whole line
  expect(firstWrite).toBeLessThan(line.length);
  expect(received).toBe(line.length);
  expect(lastByte).toBe(0x0a);
});
