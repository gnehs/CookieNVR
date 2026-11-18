import type { CameraConnection } from "../types.ts";

export function sourceUrls(conn: CameraConnection): { main: string; sub: string | null } {
  if (conn.type === "rtsp") return { main: conn.mainUrl, sub: conn.subUrl || null };
  const auth = `${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password)}`;
  const base = `rtsp://${auth}@${hostForUrl(conn.host)}:554`;
  return { main: `${base}/stream1`, sub: `${base}/stream2` };
}

export function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
