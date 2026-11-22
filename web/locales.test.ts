import { describe, expect, test } from "bun:test";

const LOCALES = ["en", "ja", "zh-Hant"] as const;

type Entry = { key: string; msgstr: string };

const unquote = (s: string): string => JSON.parse(s);

/** 解析 .po：key 是 msgctxt 加 msgid，翻譯可以跨多行；表頭（空的 msgid）略過 */
function parsePo(text: string): Entry[] {
  const entries: Entry[] = [];
  let ctxt = "";
  let id = "";
  let str = "";
  let field: "msgctxt" | "msgid" | "msgstr" | null = null;
  const flush = () => {
    if (field !== null && id !== "") entries.push({ key: `${ctxt}\u0004${id}`, msgstr: str });
    ctxt = id = str = "";
    field = null;
  };
  for (const line of text.split("\n")) {
    const m = /^(msgctxt|msgid|msgstr) (".*")$/.exec(line);
    if (m) {
      const name = m[1] as "msgctxt" | "msgid" | "msgstr";
      if (name === "msgctxt" && field === "msgstr") flush();
      if (name === "msgid" && field === "msgstr") flush();
      field = name;
      const value = unquote(m[2]!);
      if (name === "msgctxt") ctxt = value;
      else if (name === "msgid") id = value;
      else str = value;
    } else if (field !== null && line.startsWith('"')) {
      const value = unquote(line);
      if (field === "msgctxt") ctxt += value;
      else if (field === "msgid") id += value;
      else str += value;
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return entries;
}

const catalogs = Object.fromEntries(
  await Promise.all(LOCALES.map(async (l) => [l, parsePo(await Bun.file(new URL(`./locales/${l}.po`, import.meta.url)).text())] as const)),
) as Record<(typeof LOCALES)[number], Entry[]>;

describe("locales", () => {
  test("parser reads every entry", () => {
    for (const l of LOCALES) expect(catalogs[l].length).toBeGreaterThan(1000);
  });

  test("en, ja and zh-Hant carry the same message ids", () => {
    const keys = (l: (typeof LOCALES)[number]) => new Set(catalogs[l].map((e) => e.key));
    const en = keys("en");
    for (const l of ["ja", "zh-Hant"] as const) {
      const other = keys(l);
      expect({ locale: l, missing: [...en].filter((k) => !other.has(k)) }).toEqual({ locale: l, missing: [] });
      expect({ locale: l, extra: [...other].filter((k) => !en.has(k)) }).toEqual({ locale: l, extra: [] });
    }
  });

  test("ja and zh-Hant have no empty translations", () => {
    for (const l of ["ja", "zh-Hant"] as const) {
      expect({ locale: l, empty: catalogs[l].filter((e) => e.msgstr.trim() === "").map((e) => e.key) }).toEqual({ locale: l, empty: [] });
    }
  });
});
