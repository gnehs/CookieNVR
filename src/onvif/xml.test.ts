import { describe, expect, test } from "bun:test";
import { child, escapeXml, find, parseXml, path, serializeXml, textOf, XmlParseError } from "./xml.ts";

describe("parseXml", () => {
  test("用命名空間 URI 而不是前綴辨識元素", () => {
    const a = parseXml(`<s:Envelope xmlns:s="urn:env" xmlns:tt="urn:tt"><s:Body><tt:Name>x</tt:Name></s:Body></s:Envelope>`);
    const b = parseXml(`<Envelope xmlns="urn:env"><Body><q:Name xmlns:q="urn:tt">x</q:Name></Body></Envelope>`);
    for (const root of [a, b]) {
      expect(root.ns).toBe("urn:env");
      const name = path(root, "Body", "Name");
      expect(name?.ns).toBe("urn:tt");
      expect(textOf(name)).toBe("x");
    }
  });

  test("子元素可以重新宣告同一個前綴", () => {
    const root = parseXml(`<a:r xmlns:a="urn:1"><a:c xmlns:a="urn:2"/><a:d/></a:r>`);
    expect(child(root, "c")?.ns).toBe("urn:2");
    expect(child(root, "d")?.ns).toBe("urn:1");
  });

  test("解碼實體與數字字元參照、保留 CDATA 原文", () => {
    const root = parseXml(`<r a="1 &amp; 2 &quot;q&quot;">&lt;b&gt; &#x4E2D;&#25991; <![CDATA[<raw> & ]]>end</r>`);
    expect(root.attrs.a).toBe('1 & 2 "q"');
    expect(root.text).toBe("<b> 中文 <raw> & end");
  });

  test("略過 XML 宣告、註解與 processing instruction", () => {
    const root = parseXml(`<?xml version="1.0"?><!-- c --><r><?pi x?><!-- <fake/> --><k>v</k></r>`);
    expect(root.children.map((c) => c.local)).toEqual(["k"]);
  });

  test("屬性接受單引號與帶前綴的屬性", () => {
    const root = parseXml(`<r xmlns:x="urn:x" x:flag='yes' plain="1"/>`);
    expect(root.attrs.flag).toBe("yes");
    expect(root.attrs["{urn:x}flag"]).toBe("yes");
    expect(root.attrs.plain).toBe("1");
  });

  test("格式錯誤與 DTD 都丟 XmlParseError", () => {
    for (const bad of ["<a><b></a>", "<a>", "", "<a/><b/>", `<!DOCTYPE x [<!ENTITY e "boom">]><a>&e;</a>`, "<p:a/>"]) {
      expect(() => parseXml(bad)).toThrow(XmlParseError);
    }
  });

  test("Tapo 的元素名稱裡有點號", () => {
    const root = parseXml(`<tt:Security xmlns:tt="urn:tt"><tt:TLS1.1>false</tt:TLS1.1><tt:X.509Token>false</tt:X.509Token></tt:Security>`);
    expect(find(root, "TLS1.1")?.text).toBe("false");
  });
});

describe("escapeXml", () => {
  test("跳脫後再解析得回原字串", () => {
    const nasty = `a<b>&"c'd]]>`;
    expect(parseXml(`<r v="${escapeXml(nasty)}">${escapeXml(nasty)}</r>`)).toMatchObject({ text: nasty, attrs: { v: nasty } });
  });
});

describe("serializeXml", () => {
  test("序列化後自帶命名空間，可以放進另一份文件", () => {
    const el = child(parseXml(`<r xmlns:q="urn:q"><q:Ref id="1">a&amp;b</q:Ref></r>`), "Ref")!;
    const again = parseXml(serializeXml(el));
    expect(again).toMatchObject({ local: "Ref", ns: "urn:q", text: "a&b", attrs: { id: "1" } });
  });
});
