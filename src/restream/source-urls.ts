import type { CameraConnection } from "../types.ts";

const DEFAULT_RTSP_PORT = 554;

export function sourceUrls(conn: CameraConnection): { main: string; sub: string | null } {
  if (conn.type === "rtsp") return { main: conn.mainUrl, sub: conn.subUrl || null };
  const auth = `${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password)}`;
  const { host, port } = splitHostPort(conn.host);
  const base = `rtsp://${auth}@${host}:${port}`;
  return { main: `${base}/stream1`, sub: `${base}/stream2` };
}

/**
 * 接受 "192.168.1.20"、"192.168.1.20:8554"、"cam.local:8554"、"fe80::1"、"[fe80::1]:8554"。
 * 只有一個冒號才可能是「主機:埠」；兩個以上就是沒加括號的 IPv6 位址。
 */
export function splitHostPort(input: string): { host: string; port: number } {
  const value = input.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: `[${bracketed[1]}]`, port: Number(bracketed[2] ?? DEFAULT_RTSP_PORT) };
  const colons = value.split(":").length - 1;
  if (colons > 1) return { host: `[${value}]`, port: DEFAULT_RTSP_PORT };
  const withPort = /^([^:]+):(\d+)$/.exec(value);
  if (withPort) return { host: withPort[1] ?? value, port: Number(withPort[2]) };
  return { host: value, port: DEFAULT_RTSP_PORT };
}

/** 給不含埠的主機名稱用：沒加括號的 IPv6 位址補上括號。 */
export function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
