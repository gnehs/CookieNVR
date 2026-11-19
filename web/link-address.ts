/** 私有網段、loopback 與 IPv6 ULA／link-local：請求來自家裡的網路 */
export function isLocalAddress(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return ip === "::1" || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
}
