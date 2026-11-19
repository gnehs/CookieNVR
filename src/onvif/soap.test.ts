import { describe, expect, test } from "bun:test";
import { buildEnvelope, formatCreated, parseFault, passwordDigest } from "./soap.ts";
import { child, find, parseXml, path } from "./xml.ts";

describe("WS-Security UsernameToken", () => {
  test("PasswordDigest = Base64(SHA1(nonce + created + password))，對照 openssl 算出的值", () => {
    const nonce = new TextEncoder().encode("nonce-16-bytes!!");
    expect(passwordDigest(nonce, "2026-01-02T03:04:05Z", "密碼&<x>")).toBe("8gsIxDDHq4Hs4N7jAdILTHmXedI=");
  });

  test("Created 用相機時鐘、精確到秒", () => {
    expect(formatCreated(Date.UTC(2026, 0, 2, 3, 4, 5, 678))).toBe("2026-01-02T03:04:05Z");
  });

  test("信封帶 UsernameToken，帳號跳脫、密碼不以明文出現", () => {
    const xml = buildEnvelope({
      url: "http://cam/onvif",
      action: "urn:a",
      name: "X",
      body: "<X/>",
      credentials: { username: `a<&"b`, password: "plain-secret" },
      cameraNow: Date.UTC(2026, 0, 1),
    });
    expect(xml).not.toContain("plain-secret");
    const token = find(parseXml(xml), "UsernameToken");
    expect(child(token, "Username")?.text).toBe(`a<&"b`);
    expect(child(token, "Created")?.text).toBe("2026-01-01T00:00:00Z");
    expect(child(token, "Password")?.attrs.Type).toEndWith("#PasswordDigest");
  });

  test("addressing 時加上 wsa:Action 與 wsa:To", () => {
    const root = parseXml(buildEnvelope({ url: "http://cam:1024/event-1", action: "urn:pull", name: "P", body: "<P/>", addressing: true }));
    const header = child(root, "Header");
    expect(child(header, "To")?.text).toBe("http://cam:1024/event-1");
    expect(child(header, "Action")?.text).toBe("urn:pull");
  });
});

describe("parseFault", () => {
  test("SOAP 1.2：取最內層 Subcode 並去掉前綴", () => {
    const fault = path(
      parseXml(
        `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault><e:Code><e:Value>e:Sender</e:Value>` +
          `<e:Subcode><e:Value>ter:InvalidArgVal</e:Value><e:Subcode><e:Value>ter:NoProfile</e:Value></e:Subcode></e:Subcode></e:Code>` +
          `<e:Reason><e:Text xml:lang="en">No such profile</e:Text></e:Reason></e:Fault></e:Body></e:Envelope>`,
      ),
      "Body",
      "Fault",
    )!;
    expect(parseFault(fault)).toEqual({ code: "Sender", subcode: "NoProfile", reason: "No such profile" });
  });

  test("SOAP 1.1：faultcode 與 faultstring", () => {
    const fault = parseXml(`<s:Fault xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><faultcode>s:Client</faultcode><faultstring>bad</faultstring></s:Fault>`);
    expect(parseFault(fault)).toEqual({ code: "Client", subcode: null, reason: "bad" });
  });
});
