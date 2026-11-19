import { describe, expect, test } from "bun:test";
import { decodeMessage, DnsParseError, encodeMessage, TYPE, type DnsMessage } from "./dns.ts";
import { sameSubnet } from "./responder.ts";
import { announcement, answerQuery, hostLabel, instanceLabel, SERVICE_TYPE, type ServiceInfo } from "./service.ts";

const ID = "1a2b3c4d-0000-4000-8000-000000000000";
const info: ServiceInfo = {
  instance: instanceLabel("Home NVR", ID),
  host: hostLabel(ID),
  port: 8765,
  txt: { id: ID, version: "1.2.3", api: "1" },
};

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const query = (name: string, type: number, extra: Partial<DnsMessage> = {}): DnsMessage => ({
  id: 0,
  isResponse: false,
  questions: [{ name, type, unicastResponse: false }],
  answers: [],
  additionals: [],
  ...extra,
});

describe("dns codec", () => {
  test("decodes a query captured from macOS mDNSResponder (compressed names, QU bit)", () => {
    const msg = decodeMessage(
      hex("000000000002000000000000074b69746368656e0a5f636f6f6b69656e7672045f746370056c6f63616c0000218001c00c00108001"),
    );
    expect(msg.isResponse).toBe(false);
    expect(msg.questions).toEqual([
      { name: "Kitchen._cookienvr._tcp.local", type: TYPE.SRV, unicastResponse: true },
      { name: "Kitchen._cookienvr._tcp.local", type: TYPE.TXT, unicastResponse: true },
    ]);
  });

  test("an announcement survives an encode/decode round trip", () => {
    const msg = announcement(info, "192.168.1.20");
    const back = decodeMessage(encodeMessage(msg));
    expect(back.isResponse).toBe(true);
    expect(back.answers).toEqual(msg.answers);
  });

  test("keeps UTF-8 instance names and TXT values intact", () => {
    const named = { ...info, instance: instanceLabel("客廳的 NVR", ID) };
    const back = decodeMessage(encodeMessage(announcement(named, "10.0.0.2")));
    expect(back.answers[0]).toMatchObject({ type: "PTR", target: `客廳的 NVR (1a2b).${SERVICE_TYPE}` });
  });

  test("rejects truncated packets and compression loops instead of hanging", () => {
    const full = encodeMessage(announcement(info, "10.0.0.2"));
    expect(() => decodeMessage(full.subarray(0, full.length - 3))).toThrow(DnsParseError);
    // 問題名稱是一個指向自己的指標
    expect(() => decodeMessage(hex("000000000001000000000000c00c000c0001"))).toThrow(DnsParseError);
  });

  test("skips record types it does not understand", () => {
    const aaaa = hex(
      "000084000000000100000000" + "04686f7374056c6f63616c00" + "001c8001" + "00000078" + "0010" + "fe800000000000000000000000000001",
    );
    expect(decodeMessage(aaaa).answers).toEqual([
      { name: "host.local", type: "OTHER", code: TYPE.AAAA, ttl: 120, cacheFlush: true },
    ]);
  });
});

describe("service records", () => {
  test("instance labels stay within one 63-byte DNS label and carry the instance id", () => {
    expect(instanceLabel("Home NVR", ID)).toBe("Home NVR (1a2b)");
    expect(instanceLabel("a.b", ID)).toBe("a b (1a2b)");
    expect(instanceLabel("", ID)).toBe("CookieNVR (1a2b)");
    const long = instanceLabel("錄".repeat(40), ID);
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(63);
    expect(long.endsWith(" (1a2b)")).toBe(true);
    expect(hostLabel(ID)).toBe("cookienvr-1a2b3c4d.local");
  });

  test("a browse query gets the PTR plus SRV, TXT and A as additionals", () => {
    const reply = answerQuery(query("_cookienvr._tcp.local.", TYPE.PTR), info, "192.168.1.20")!;
    expect(reply.answers.map((r) => r.type)).toEqual(["PTR"]);
    expect(reply.additionals.map((r) => r.type)).toEqual(["SRV", "TXT", "A"]);
    expect(reply.additionals).toContainEqual(expect.objectContaining({ type: "SRV", port: 8765, target: info.host }));
    expect(reply.additionals).toContainEqual(expect.objectContaining({ type: "A", address: "192.168.1.20" }));
    expect(reply.additionals).toContainEqual(
      expect.objectContaining({ type: "TXT", entries: [`id=${ID}`, "version=1.2.3", "api=1"] }),
    );
  });

  test("answers resolve, address and service-enumeration queries; ignores everything else", () => {
    const fqdn = `${info.instance}.${SERVICE_TYPE}`;
    expect(answerQuery(query(fqdn, TYPE.SRV), info, "10.0.0.2")!.answers.map((r) => r.type)).toEqual(["SRV"]);
    expect(answerQuery(query(fqdn.toUpperCase(), TYPE.ANY), info, "10.0.0.2")!.answers.map((r) => r.type)).toEqual(["SRV", "TXT"]);
    expect(answerQuery(query(info.host, TYPE.A), info, "10.0.0.2")!.answers).toEqual([
      expect.objectContaining({ type: "A", address: "10.0.0.2" }),
    ]);
    expect(answerQuery(query("_services._dns-sd._udp.local", TYPE.PTR), info, "10.0.0.2")!.answers).toEqual([
      expect.objectContaining({ target: SERVICE_TYPE }),
    ]);
    expect(answerQuery(query("_airplay._tcp.local", TYPE.PTR), info, "10.0.0.2")).toBeNull();
    expect(answerQuery({ ...announcement(info, "10.0.0.2") }, info, "10.0.0.2")).toBeNull();
  });

  test("skips a PTR the querier already knows (known-answer suppression)", () => {
    const known = announcement(info, "10.0.0.2").answers[0]!;
    expect(answerQuery(query(SERVICE_TYPE, TYPE.PTR, { answers: [known] }), info, "10.0.0.2")).toBeNull();
    const stale = { ...known, ttl: 100 };
    expect(answerQuery(query(SERVICE_TYPE, TYPE.PTR, { answers: [stale] }), info, "10.0.0.2")).not.toBeNull();
  });

  test("legacy unicast queries get their id and question echoed with TTLs capped at 10 s", () => {
    const reply = answerQuery({ ...query(SERVICE_TYPE, TYPE.PTR), id: 4242 }, info, "10.0.0.2", true)!;
    expect(reply.id).toBe(4242);
    expect(reply.questions).toHaveLength(1);
    expect([...reply.answers, ...reply.additionals].every((r) => r.ttl <= 10 && !r.cacheFlush)).toBe(true);
  });

  test("goodbye announcements carry TTL 0", () => {
    expect(announcement(info, "10.0.0.2", true).answers.every((r) => r.ttl === 0)).toBe(true);
  });

  test("replies go out the interface on the querier's subnet", () => {
    const lan = { address: "192.168.1.20", netmask: "255.255.255.0" };
    expect(sameSubnet(lan, "192.168.1.77")).toBe(true);
    expect(sameSubnet(lan, "192.168.2.77")).toBe(false);
    expect(sameSubnet({ address: "127.0.0.1", netmask: "255.0.0.0" }, "127.0.0.1")).toBe(true);
  });
});
