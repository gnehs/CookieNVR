import type { StreamMessage, StreamSnapshotDto } from "../api-types.ts";
import type { Principal, Route } from "../types.ts";
import { queuedStream } from "./queued-stream.ts";

export interface StreamClient {
  principal: Principal;
  /** The request that opened the stream; camera DTOs derive RTSP URLs from its host. */
  req: Request;
}

export interface StreamHubOptions {
  snapshot(client: StreamClient): StreamSnapshotDto;
  pingMs?: number;
  /** A client this far behind is dropped; it reconnects and starts over from a snapshot. */
  maxBacklogBytes?: number;
}

export interface StreamHub {
  /** `render` decides per client what it gets, or null for nothing (e.g. worker status for non-admins). */
  publish(render: (client: StreamClient) => StreamMessage | null): void;
  clients(): number;
  route(): Route;
}

const encoder = new TextEncoder();

/** One SSE message. JSON.stringify never emits a raw newline, so `data` fits on one line. */
export function formatSse(msg: StreamMessage): string {
  return `event: ${msg.type}\ndata: ${JSON.stringify(msg.data)}\n\n`;
}

export function createStreamHub(opts: StreamHubOptions): StreamHub {
  const pingMs = opts.pingMs ?? 20_000;
  const maxBacklog = opts.maxBacklogBytes ?? 1024 * 1024;
  const clients = new Map<StreamClient, ReturnType<typeof queuedStream>>();

  function send(client: StreamClient, text: string): void {
    const q = clients.get(client);
    if (!q) return;
    q.enqueue(encoder.encode(text));
    if (q.backlog() > maxBacklog) q.abort();
  }

  return {
    publish(render) {
      for (const client of [...clients.keys()]) {
        const msg = render(client);
        if (msg) send(client, formatSse(msg));
      }
    },
    clients: () => clients.size,
    route: () => ({
      method: "GET",
      path: "/api/stream",
      access: "user",
      handler(ctx) {
        const client: StreamClient = { principal: ctx.principal!, req: ctx.req };
        const ping = setInterval(() => send(client, ": ping\n\n"), pingMs);
        const q = queuedStream(maxBacklog, () => {
          clearInterval(ping);
          clients.delete(client);
        });
        clients.set(client, q);
        send(client, `retry: 3000\n\n${formatSse({ type: "snapshot", data: opts.snapshot(client) })}`);
        return new Response(q.stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            // nginx buffers proxied responses unless told otherwise
            "x-accel-buffering": "no",
          },
        });
      },
    }),
  };
}
