import { describe, expect, test } from "bun:test";
import type { StreamMessage, StreamSnapshotDto } from "../api-types.ts";
import type { CameraId, Principal, WorkerStatus } from "../types.ts";
import { createStreamHub, formatSse } from "./hub.ts";

const admin: Principal = { userId: 1, username: "a", role: "admin", via: "session" };
const user: Principal = { userId: 2, username: "u", role: "user", via: "session" };
const worker = { id: "restream", kind: "restream", state: "running" } as WorkerStatus;

function connect(hub: ReturnType<typeof createStreamHub>, principal: Principal) {
  const url = new URL("http://nvr/api/stream");
  const res = hub.route().handler({ req: new Request(url), url, params: {}, principal, ip: "" }) as Response;
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  /** Messages parsed the way EventSource does: blocks split by a blank line, comments skipped. */
  const next = async (): Promise<{ event: string; data: unknown }> => {
    for (;;) {
      const end = text.indexOf("\n\n");
      if (end >= 0) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const fields = Object.fromEntries(block.split("\n").filter((l) => !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
        if (fields.event) return { event: fields.event, data: JSON.parse(fields.data!) };
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      text += value;
    }
  };
  return { res, next, close: () => reader.cancel() };
}

const snapshot = (workers: WorkerStatus[] | null): StreamSnapshotDto => ({ cameras: [], workers, events: [] });

describe("formatSse", () => {
  test("names the event and puts the JSON on one data line", () => {
    const msg: StreamMessage = { type: "motion", data: { cameraId: "c\n1" as CameraId, active: true } };
    expect(formatSse(msg)).toBe('event: motion\ndata: {"cameraId":"c\\n1","active":true}\n\n');
  });
});

describe("stream hub", () => {
  test("a client first gets the full state, then what is published for it", async () => {
    const hub = createStreamHub({ snapshot: (c) => snapshot(c.principal.role === "admin" ? [worker] : null) });
    const a = connect(hub, admin);
    const u = connect(hub, user);
    expect(a.res.headers.get("content-type")).toStartWith("text/event-stream");
    expect(await a.next()).toEqual({ event: "snapshot", data: snapshot([worker]) });
    expect(await u.next()).toEqual({ event: "snapshot", data: snapshot(null) });

    hub.publish((c) => (c.principal.role === "admin" ? { type: "worker", data: worker } : null));
    hub.publish(() => ({ type: "motion", data: { cameraId: "c1" as CameraId, active: false } }));
    expect(await a.next()).toEqual({ event: "worker", data: worker });
    expect((await a.next()).event).toBe("motion");
    expect((await u.next()).event).toBe("motion");
    await a.close();
    await u.close();
    expect(hub.clients()).toBe(0);
  });

  test("a client that stops reading is dropped once it falls too far behind", async () => {
    const hub = createStreamHub({ snapshot: () => snapshot(null), maxBacklogBytes: 2_000 });
    const slow = connect(hub, user);
    for (let i = 0; i < 50; i++) hub.publish(() => ({ type: "worker", data: worker }));
    expect(hub.clients()).toBe(0);
    const drain = async () => {
      for (;;) await slow.next();
    };
    await expect(drain()).rejects.toThrow();
  });

  test("cuts off a client whose credentials were revoked", async () => {
    let valid = true;
    const hub = createStreamHub({ snapshot: () => snapshot(null), pingMs: 10, stillAuthorized: () => valid });
    const client = connect(hub, user);
    expect((await client.next()).event).toBe("snapshot");
    valid = false;
    await expect(client.next()).rejects.toThrow();
    expect(hub.clients()).toBe(0);
  });

  test("keeps idle connections alive with comment lines", async () => {
    const hub = createStreamHub({ snapshot: () => snapshot(null), pingMs: 10 });
    const url = new URL("http://nvr/api/stream");
    const res = hub.route().handler({ req: new Request(url), url, params: {}, principal: user, ip: "" }) as Response;
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes(": ping\n\n")) text += (await reader.read()).value;
    await reader.cancel();
  });
});
