import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { decodeMessage, encodeMessage, MAX_PACKET_BYTES, type DnsMessage } from "./dns.ts";
import { announcement, answerQuery, type ServiceInfo } from "./service.ts";

const GROUP = "224.0.0.251";
const PORT = 5353;
const ANNOUNCE_DELAYS_MS = [0, 1000, 2000];
const INTERFACE_POLL_MS = 30_000;

export interface Iface {
  address: string;
  netmask: string;
}

export interface MdnsOptions {
  info: () => ServiceInfo;
  interfaces?: () => Iface[];
  onError: (error: unknown) => void;
}

export interface MdnsResponder {
  /** 站點名稱或埠改變後呼叫：舊名稱送 goodbye，再廣播新的 */
  refresh(): void;
  stop(): Promise<void>;
}

/** 所有 IPv4 介面（含 loopback，讓同一台主機上的 HA 也找得到），排除 169.254 自動位址 */
export function ipv4Interfaces(): Iface[] {
  const out: Iface[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.address.startsWith("169.254.")) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function toInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

export function sameSubnet(iface: Iface, ip: string): boolean {
  const mask = toInt(iface.netmask);
  return ((toInt(iface.address) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0);
}

/**
 * 最小的 mDNS 回應器：只回答自己的服務，不做名稱探測（實例名稱帶識別碼，不會撞名）。
 * 每個介面各自用該介面的位址回答，查詢來自哪個子網就從那個介面回。
 */
export async function startMdns(opts: MdnsOptions): Promise<MdnsResponder> {
  const listInterfaces = opts.interfaces ?? ipv4Interfaces;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let ifaces: Iface[] = [];
  let current = opts.info();
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const reported = new Set<string>();

  const reportOnce = (key: string, error: unknown) => {
    if (reported.has(key)) return;
    reported.add(key);
    opts.onError(error);
  };

  // dgram 的 send 是非同步的，設定外送介面與送出必須成對、依序執行
  let queue = Promise.resolve();
  function send(msg: DnsMessage, via: Iface, to: { address: string; port: number } = { address: GROUP, port: PORT }) {
    const buf = encodeMessage(msg);
    queue = queue.then(
      () =>
        new Promise<void>((resolve) => {
          if (stopped && msg.answers.some((a) => a.ttl > 0)) return resolve();
          try {
            if (to.address === GROUP) socket.setMulticastInterface(via.address);
            socket.send(buf, to.port, to.address, (err) => {
              if (err) reportOnce(`send:${via.address}`, new Error(`mDNS 無法從 ${via.address} 送出：${err.message}`));
              resolve();
            });
          } catch (err) {
            reportOnce(`send:${via.address}`, err);
            resolve();
          }
        }),
    );
    return queue;
  }

  function later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  }

  function announce(targets: Iface[]) {
    for (const delay of ANNOUNCE_DELAYS_MS) {
      later(delay, () => {
        for (const iface of targets) void send(announcement(current, iface.address), iface);
      });
    }
  }

  function join(list: Iface[]) {
    for (const iface of list) {
      try {
        socket.addMembership(GROUP, iface.address);
      } catch (err) {
        reportOnce(`join:${iface.address}`, err);
      }
    }
  }

  function syncInterfaces() {
    const next = listInterfaces();
    const known = new Set(ifaces.map((i) => i.address));
    const added = next.filter((i) => !known.has(i.address));
    ifaces = next;
    if (added.length === 0) return;
    join(added);
    announce(added);
  }

  socket.on("message", (buf, rinfo) => {
    // 回應（QR 位元）與過大的封包連解析都不做
    if (buf.length < 12 || buf.length > MAX_PACKET_BYTES || (buf[2]! & 0x80) !== 0) return;
    // 只回答同一個區域網路上的查詢（RFC 6762 §11），避免被當成反射放大器
    const matching = ifaces.filter((i) => sameSubnet(i, rinfo.address));
    if (matching.length === 0) return;
    let query: DnsMessage;
    try {
      query = decodeMessage(buf);
    } catch {
      return;
    }
    if (query.isResponse || query.questions.length === 0) return;
    const legacy = rinfo.port !== PORT;
    for (const iface of matching) {
      const reply = answerQuery(query, current, iface.address, legacy);
      if (!reply) return;
      void send(reply, iface, legacy ? { address: rinfo.address, port: rinfo.port } : undefined);
    }
  });
  socket.on("error", (err) => reportOnce(`socket:${err.message}`, err));

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(PORT, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  socket.setMulticastTTL(255);
  socket.setMulticastLoopback(true);
  syncInterfaces();
  const poll = setInterval(syncInterfaces, INTERFACE_POLL_MS);

  return {
    refresh() {
      const next = opts.info();
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      for (const iface of ifaces) void send(announcement(current, iface.address, true), iface);
      current = next;
      announce(ifaces);
    },
    async stop() {
      if (stopped) return;
      clearInterval(poll);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const iface of ifaces) void send(announcement(current, iface.address, true), iface);
      stopped = true;
      await queue;
      socket.close();
    },
  };
}
