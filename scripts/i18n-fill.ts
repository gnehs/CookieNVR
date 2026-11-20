// 用法：bun scripts/i18n-fill.ts <locale> <對照表.json>...
// 對照表是 { "英文原文": "譯文" }，有 context 的訊息用 "context\u0004英文原文" 當 key。只填空白的 msgstr，已經翻好的不動
import { readFileSync, writeFileSync } from "node:fs";
import { formatter } from "@lingui/format-po";

const [locale, ...maps] = process.argv.slice(2);
if (!locale || maps.length === 0) throw new Error("usage: bun scripts/i18n-fill.ts <locale> <map.json>...");

const table: Record<string, string> = Object.assign({}, ...maps.map((f) => JSON.parse(readFileSync(f, "utf8"))));
const file = `web/locales/${locale}.po`;
const po = formatter({ lineNumbers: false });
const ctx = { locale, sourceLocale: "en", filename: file };
const catalog = (await po.parse(readFileSync(file, "utf8"), ctx))!;

let filled = 0;
const missing: string[] = [];
for (const entry of Object.values(catalog)) {
  if (entry.translation || !entry.message) continue;
  const key = entry.context ? `${entry.context}\u0004${entry.message}` : entry.message;
  const tr = table[key];
  if (tr == null) missing.push(key);
  else {
    entry.translation = tr;
    filled++;
  }
}
writeFileSync(file, await po.serialize(catalog, { ...ctx, existing: readFileSync(file, "utf8") }));
console.log(`${locale}: filled ${filled}, still missing ${missing.length}`);
for (const m of missing) console.log(`  ${JSON.stringify(m)}`);
