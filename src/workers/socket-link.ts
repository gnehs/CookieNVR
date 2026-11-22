import { rmSync } from "node:fs";
import type { Socket, UnixSocketListener } from "bun";
import { SocketWriter } from "../homekit/protocol.ts";
import { MsgReader } from "./framing.ts";

export interface SocketLinkOptions {
  /** Unix socket 路徑；macOS 限制約 104 字元，所以放 /tmp 而不是 dataDir */
  path: string;
  now: () => number;
  onMessage: (kind: number, payload: Uint8Array<ArrayBuffer>) => void;
  /** 連線斷了，或被更新的連線取代；每次有新連線進來前也會先呼叫一次 */
  onDisconnect: () => void;
  onError: (e: unknown) => void;
}

/** 主程序這端的 Python worker socket：主程序監聽，worker 連進來，只認最新的一條連線 */
export interface SocketLink {
  /** 開始監聽；已在監聽就不動 */
  listen(): void;
  connected(): boolean;
  /** 寫給目前的連線，寫不完的等 drain 再送；沒有連線就丟掉 */
  write(bytes: Uint8Array): void;
  /** 最近一次連上或收到訊息的時間，判斷 worker 卡死用 */
  lastSeenAt(): number;
  stop(): void;
}

export function createSocketLink(opts: SocketLinkOptions): SocketLink {
  let listener: UnixSocketListener<undefined> | null = null;
  let conn: { socket: Socket<undefined>; writer: SocketWriter; reader: MsgReader } | null = null;
  let lastSeenAt = 0;

  function disconnected(): void {
    conn = null;
    opts.onDisconnect();
  }

  return {
    listen() {
      if (listener) return;
      rmSync(opts.path, { force: true });
      listener = Bun.listen<undefined>({
        unix: opts.path,
        socket: {
          open(socket) {
            // 重啟時舊程序可能還沒斷線：只認最新的連線
            conn?.socket.end();
            disconnected();
            conn = { socket, writer: new SocketWriter(socket), reader: new MsgReader() };
            lastSeenAt = opts.now();
          },
          data(socket, chunk) {
            if (socket !== conn?.socket) return;
            for (const m of conn.reader.push(chunk)) {
              lastSeenAt = opts.now();
              opts.onMessage(m.kind, m.payload);
            }
          },
          drain(socket) {
            if (socket === conn?.socket) conn.writer.drain();
          },
          close(socket) {
            if (socket === conn?.socket) disconnected();
          },
          error(socket, e) {
            opts.onError(e);
            if (socket === conn?.socket) disconnected();
          },
        },
      });
    },
    connected: () => conn !== null,
    write(bytes) {
      conn?.writer.writeBytes(bytes);
    },
    lastSeenAt: () => lastSeenAt,
    stop() {
      conn?.socket.end();
      listener?.stop(true);
      listener = null;
      rmSync(opts.path, { force: true });
    },
  };
}
