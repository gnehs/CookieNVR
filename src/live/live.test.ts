import { beforeAll, describe, expect, test } from "bun:test";
import { Mp4Splitter, type Unit } from "../../web/playback/mp4.ts";
import type { CameraId } from "../types.ts";
import { Channel, isSyncFragment, type Viewer } from "./channel.ts";
import { createLive, pumpRun, type LiveSource, type Quality } from "./live.ts";
import { encodeFrame, FrameKind, FrameReader } from "./mux.ts";

let init: Uint8Array;
let frags: Uint8Array[];
let raw: Uint8Array<ArrayBuffer>;

/** Real ffmpeg output with the live worker's muxer flags: GOP of 1 s, fragments every 200 ms. */
beforeAll(async () => {
  const proc = Bun.spawn(
    [
      "ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "3",
      "-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p",
      "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "200000", "pipe:1",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  raw = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const units: Unit[] = new Mp4Splitter().push(raw);
  init = units.find((u) => u.kind === "init")!.bytes;
  frags = units.filter((u) => u.kind === "media").map((u) => u.bytes);
});

class FakeViewer implements Viewer {
  got: Uint8Array[] = [];
  restarts = 0;
  closed = false;
  pendingBytes = 0;
  constructor(private readonly drains = true) {}
  send(b: Uint8Array) {
    this.got.push(b);
    if (!this.drains) this.pendingBytes += b.length;
  }
  backlog() {
    return this.pendingBytes;
  }
  restart() {
    this.restarts++;
  }
  close() {
    this.closed = true;
  }
}

const syncIndexes = () => frags.flatMap((f, i) => (isSyncFragment(f) ? [i] : []));

describe("isSyncFragment", () => {
  test("marks exactly the fragments that start a GOP", () => {
    expect(syncIndexes()).toEqual([0, 5, 10]);
  });
});

describe("Channel", () => {
  test("a newcomer gets init plus the current GOP, then live fragments", () => {
    const ch = new Channel(1 << 20);
    const run = ch.beginRun();
    ch.setInit(run, { bytes: init, codecs: ["avc1"] });
    for (const f of frags.slice(0, 7)) ch.pushFragment(run, f);
    const v = new FakeViewer();
    ch.add(v);
    expect(v.got).toEqual([init, frags[5]!, frags[6]!]);
    ch.pushFragment(run, frags[7]!);
    expect(v.got.at(-1)).toBe(frags[7]!);
  });

  test("a viewer that joins before the first keyframe waits for it", () => {
    const ch = new Channel(1 << 20);
    const run = ch.beginRun();
    const v = new FakeViewer();
    ch.add(v);
    ch.setInit(run, { bytes: init, codecs: [] });
    ch.pushFragment(run, frags[3]!);
    expect(v.got).toEqual([]);
    ch.pushFragment(run, frags[5]!);
    expect(v.got).toEqual([init, frags[5]!]);
  });

  test("a viewer over the backlog limit is dropped and the others keep receiving", () => {
    const ch = new Channel(frags[0]!.length + init.length + 1);
    const run = ch.beginRun();
    ch.setInit(run, { bytes: init, codecs: [] });
    const slow = new FakeViewer(false);
    const fast = new FakeViewer();
    ch.add(slow);
    ch.add(fast);
    for (const f of frags.slice(0, 4)) ch.pushFragment(run, f);
    expect(slow.closed).toBe(true);
    expect(fast.closed).toBe(false);
    expect(fast.got).toEqual([init, ...frags.slice(0, 4)]);
    expect(ch.viewers).toBe(1);
  });

  test("a worker restart tells viewers and re-primes them with the new init", () => {
    const ch = new Channel(1 << 20);
    let run = ch.beginRun();
    ch.setInit(run, { bytes: init, codecs: [] });
    ch.pushFragment(run, frags[0]!);
    const v = new FakeViewer();
    ch.add(v);
    ch.endRun(run);
    expect(v.restarts).toBe(1);
    const stale = run;
    run = ch.beginRun();
    ch.pushFragment(stale, frags[5]!);
    ch.setInit(run, { bytes: init, codecs: [] });
    ch.pushFragment(run, frags[5]!);
    expect(v.got).toEqual([init, frags[0]!, init, frags[5]!]);
  });

  test("a late end of an old run does not reset the new one", () => {
    const ch = new Channel(1 << 20);
    const old = ch.beginRun();
    const run = ch.beginRun();
    ch.setInit(run, { bytes: init, codecs: [] });
    ch.endRun(old);
    expect(ch.init).not.toBeNull();
  });
});

describe("pumpRun", () => {
  test("splits a byte stream arriving in odd chunks into init and fragments", async () => {
    const ch = new Channel(1 << 22);
    const v = new FakeViewer();
    ch.add(v);
    const chunks = [];
    for (let i = 0; i < raw.length; i += 777) chunks.push(raw.slice(i, i + 777));
    await pumpRun(ch, new Response(new Blob(chunks)).body!);
    expect(v.got[0]).toEqual(init);
    expect(v.got.slice(1)).toEqual(frags);
    expect(v.restarts).toBe(1);
  });
});

describe("createLive", () => {
  const cam = "cam1" as CameraId;
  function setup(sources: Partial<Record<Quality, LiveSource>> = { sd: { stream: "sub", url: "rtsp://x/sub" }, hd: { stream: "main", url: "rtsp://x/main" } }) {
    let changes = 0;
    const live = createLive({
      env: { ffmpegBin: "ffmpeg" },
      source: (id, q) => (id === cam ? (sources[q] ?? null) : null),
      onChange: () => changes++,
      lingerMs: 50,
    });
    return { live, changes: () => changes, sources };
  }

  test("a worker exists only while watched, and lingers after the last viewer leaves", async () => {
    const { live, changes } = setup();
    expect(live.workerSpecs()).toEqual([]);
    const a = live.watch(cam, "sd", new FakeViewer())!;
    const b = live.watch(cam, "sd", new FakeViewer())!;
    expect(changes()).toBe(1);
    expect(live.workerSpecs().map((s) => s.id)).toEqual(["live:cam1:sub"]);
    a.stop();
    b.stop();
    await Bun.sleep(20);
    expect(live.workerSpecs().map((s) => s.id)).toEqual(["live:cam1:sub"]);
    await Bun.sleep(60);
    expect(live.workerSpecs()).toEqual([]);
    expect(changes()).toBe(2);
  });

  test("coming back during the linger keeps the same worker", async () => {
    const { live, changes } = setup();
    live.watch(cam, "hd", new FakeViewer())!.stop();
    await Bun.sleep(20);
    live.watch(cam, "hd", new FakeViewer());
    await Bun.sleep(60);
    expect(live.workerSpecs().map((s) => s.id)).toEqual(["live:cam1:main"]);
    expect(changes()).toBe(1);
  });

  test("SD falls back to the main stream and shares its worker with HD", () => {
    const { live } = setup({ sd: { stream: "main", url: "rtsp://x/main" }, hd: { stream: "main", url: "rtsp://x/main" } });
    live.watch(cam, "sd", new FakeViewer());
    live.watch(cam, "hd", new FakeViewer());
    expect(live.viewers()).toEqual(new Map([["live:cam1:main", 2]]));
  });

  test("a camera that goes away closes its viewers and drops the worker", () => {
    const { live, sources } = setup();
    const v = new FakeViewer();
    live.watch(cam, "sd", v);
    delete sources.sd;
    expect(live.workerSpecs()).toEqual([]);
    expect(v.closed).toBe(true);
  });

  test("the worker copies video only and writes fMP4 to stdout", () => {
    const { live } = setup();
    live.watch(cam, "hd", new FakeViewer());
    const [spec] = live.workerSpecs();
    expect(spec!.cmd).toContain("copy");
    expect(spec!.cmd).toContain("-an");
    expect(spec!.cmd.at(-1)).toBe("pipe:1");
    expect(spec!.readStdout).toBeFunction();
  });
});

describe("live routes", () => {
  const cam = "cam1" as CameraId;
  function routes() {
    const live = createLive({
      env: { ffmpegBin: "ffmpeg" },
      source: (id) => (id === cam ? { stream: "sub", url: "rtsp://x/sub" } : null),
      onChange: () => {},
      initTimeoutMs: 2_000,
    });
    const [single, mux] = live.routes();
    const ctx = (path: string) => {
      const url = new URL(`http://nvr${path}`);
      return { req: new Request(url), url, params: { id: url.pathname.split("/")[3] ?? "" }, principal: null, ip: "" };
    };
    return { live, single: single!, mux: mux!, ctx };
  }

  test("live.mp4 answers once the init is there, with the codec header, and streams init + GOP", async () => {
    const { live, single, ctx } = routes();
    const pending = single.handler(ctx(`/api/cameras/${cam}/live.mp4?quality=sd`));
    const [spec] = live.workerSpecs();
    const feed = new TransformStream<Uint8Array, Uint8Array>();
    void spec!.readStdout!(feed.readable);
    void feed.writable.getWriter().write(raw);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-codec")).toStartWith("avc1.");
    const reader = res.body!.getReader();
    const splitter = new Mp4Splitter();
    const units: Unit[] = [];
    while (units.length < 2) units.push(...splitter.push((await reader.read()).value!));
    expect(units[0]!.kind).toBe("init");
    expect(units[1]!.bytes).toEqual(frags[0]!);
    await reader.cancel();
    expect(live.viewers().get("live:cam1:sub")).toBe(0);
  });

  test("rejects an unknown quality and a camera without a stream", async () => {
    const { single, ctx } = routes();
    await expect(Promise.resolve().then(() => single.handler(ctx(`/api/cameras/${cam}/live.mp4?quality=4k`)))).rejects.toMatchObject({ status: 400 });
    await expect(Promise.resolve().then(() => single.handler(ctx(`/api/cameras/nope/live.mp4`)))).rejects.toMatchObject({ status: 404 });
  });

  test("the grid stream frames each camera's data and marks missing ones gone", async () => {
    const { live, mux, ctx } = routes();
    const res = await mux.handler(ctx(`/api/live?cameras=nope,${cam}`));
    const reader = res.body!.getReader();
    const [spec] = live.workerSpecs();
    void spec!.readStdout!(new Response(raw).body!);
    const frames = new FrameReader();
    const got = [];
    while (got.filter((f) => f.kind === FrameKind.restart).length === 0) {
      const { value } = await reader.read();
      got.push(...frames.push(value!));
    }
    await reader.cancel();
    expect(got[0]).toMatchObject({ kind: FrameKind.gone, index: 0 });
    const data = got.filter((f) => f.kind === FrameKind.data);
    expect(data.every((f) => f.index === 1)).toBe(true);
    expect(data[0]!.payload).toEqual(init);
    expect(live.viewers().get("live:cam1:sub")).toBe(0);
  });
});

describe("FrameReader", () => {
  test("reassembles frames split across chunks", () => {
    const a = encodeFrame(FrameKind.data, 3, new Uint8Array([1, 2, 3]));
    const b = encodeFrame(FrameKind.gone, 4);
    const all = new Uint8Array([...a, ...b]);
    const r = new FrameReader();
    expect(r.push(all.slice(0, 4))).toEqual([]);
    expect(r.push(all.slice(4))).toEqual([
      { kind: FrameKind.data, index: 3, payload: new Uint8Array([1, 2, 3]) },
      { kind: FrameKind.gone, index: 4, payload: new Uint8Array(0) },
    ]);
  });
});
