// 精簡 XML 解析器：只處理 SOAP 回應需要的部分（命名空間、CDATA、實體），不支援 DTD。

export interface XmlElement {
  /** 不含前綴的名稱 */
  local: string;
  /** 解析後的命名空間 URI，沒有命名空間時為空字串 */
  ns: string;
  /** 以不含前綴的名稱為鍵；帶命名空間的屬性另存 `{uri}local` 鍵 */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** 直接子文字（含 CDATA）串接後的內容，未修剪 */
  text: string;
}

export class XmlParseError extends Error {
  override name = "XmlParseError";
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface RawElement {
  qname: string;
  rawAttrs: [string, string][];
  scope: Map<string, string>;
  el: XmlElement;
}

function splitQName(qname: string): [prefix: string, local: string] {
  const i = qname.indexOf(":");
  return i < 0 ? ["", qname] : [qname.slice(0, i), qname.slice(i + 1)];
}

const NAME_RE = /[^\s/>=]+/y;
const ATTR_RE = /\s*([^\s/>=]+)\s*=\s*("([^"]*)"|'([^']*)')/y;

export function parseXml(input: string): XmlElement {
  let pos = 0;
  const stack: RawElement[] = [];
  let root: XmlElement | null = null;
  const fail = (msg: string): never => {
    throw new XmlParseError(`${msg}（位置 ${pos}）`);
  };

  const skipUntil = (marker: string) => {
    const end = input.indexOf(marker, pos);
    if (end < 0) fail(`缺少 ${marker}`);
    const body = input.slice(pos, end);
    pos = end + marker.length;
    return body;
  };

  while (pos < input.length) {
    const lt = input.indexOf("<", pos);
    const textEnd = lt < 0 ? input.length : lt;
    if (textEnd > pos) {
      const top = stack.at(-1);
      const chunk = input.slice(pos, textEnd);
      if (top) top.el.text += decodeEntities(chunk);
      else if (chunk.trim()) fail("根元素外有文字");
      pos = textEnd;
      continue;
    }
    if (input.startsWith("<!--", pos)) {
      pos += 4;
      skipUntil("-->");
    } else if (input.startsWith("<![CDATA[", pos)) {
      pos += 9;
      const body = skipUntil("]]>");
      const top = stack.at(-1);
      if (!top) fail("根元素外有 CDATA");
      else top.el.text += body;
    } else if (input.startsWith("<?", pos)) {
      pos += 2;
      skipUntil("?>");
    } else if (input.startsWith("<!", pos)) {
      // DOCTYPE 與內部子集：不展開任何自訂實體，直接拒絕避免實體膨脹
      fail("不支援 DTD");
    } else if (input.startsWith("</", pos)) {
      pos += 2;
      NAME_RE.lastIndex = pos;
      const m = NAME_RE.exec(input);
      if (!m) fail("結束標籤缺少名稱");
      const name = m![0];
      pos = NAME_RE.lastIndex;
      skipUntil(">");
      const open = stack.pop();
      if (!open || open.qname !== name) fail(`結束標籤 </${name}> 不成對`);
    } else {
      pos += 1;
      NAME_RE.lastIndex = pos;
      const m = NAME_RE.exec(input);
      if (!m) fail("開始標籤缺少名稱");
      const qname = m![0];
      pos = NAME_RE.lastIndex;
      const rawAttrs: [string, string][] = [];
      for (;;) {
        ATTR_RE.lastIndex = pos;
        const a = ATTR_RE.exec(input);
        if (!a) break;
        rawAttrs.push([a[1]!, decodeEntities(a[3] ?? a[4] ?? "")]);
        pos = ATTR_RE.lastIndex;
      }
      while (/\s/.test(input[pos] ?? "")) pos++;
      let selfClosing = false;
      if (input.startsWith("/>", pos)) {
        selfClosing = true;
        pos += 2;
      } else if (input[pos] === ">") {
        pos += 1;
      } else {
        fail(`標籤 <${qname}> 格式錯誤`);
      }

      const parent = stack.at(-1);
      const scope = new Map(parent?.scope ?? [["xml", XML_NS]]);
      for (const [k, v] of rawAttrs) {
        if (k === "xmlns") scope.set("", v);
        else if (k.startsWith("xmlns:")) scope.set(k.slice(6), v);
      }
      const [prefix, local] = splitQName(qname);
      const ns = scope.get(prefix);
      if (ns === undefined && prefix) fail(`未宣告的命名空間前綴 ${prefix}`);
      const attrs: Record<string, string> = {};
      for (const [k, v] of rawAttrs) {
        if (k === "xmlns" || k.startsWith("xmlns:")) continue;
        const [ap, al] = splitQName(k);
        attrs[al] = v;
        if (ap) {
          const auri = scope.get(ap);
          if (auri) attrs[`{${auri}}${al}`] = v;
        }
      }
      const el: XmlElement = { local, ns: ns ?? "", attrs, children: [], text: "" };
      if (parent) parent.el.children.push(el);
      else if (root) fail("有多個根元素");
      else root = el;
      if (!selfClosing) stack.push({ qname, rawAttrs, scope, el });
    }
  }
  if (stack.length) fail(`<${stack.at(-1)!.qname}> 沒有結束`);
  if (!root) fail("沒有根元素");
  return root!;
}

/** 依不含前綴的名稱找第一個子元素；給 ns 時同時比對命名空間 */
export function child(el: XmlElement | undefined, local: string, ns?: string): XmlElement | undefined {
  return el?.children.find((c) => c.local === local && (ns === undefined || c.ns === ns));
}

export function children(el: XmlElement | undefined, local: string): XmlElement[] {
  return el ? el.children.filter((c) => c.local === local) : [];
}

/** 沿著一串子元素名稱往下找 */
export function path(el: XmlElement | undefined, ...locals: string[]): XmlElement | undefined {
  let cur = el;
  for (const l of locals) cur = child(cur, l);
  return cur;
}

/** 深度優先找第一個符合名稱的後代（含自己） */
export function find(el: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!el) return undefined;
  if (el.local === local) return el;
  for (const c of el.children) {
    const hit = find(c, local);
    if (hit) return hit;
  }
  return undefined;
}

export function findAll(el: XmlElement | undefined, local: string, out: XmlElement[] = []): XmlElement[] {
  if (!el) return out;
  if (el.local === local) out.push(el);
  for (const c of el.children) findAll(c, local, out);
  return out;
}

export function textOf(el: XmlElement | undefined): string | undefined {
  return el?.text.trim();
}

/** 把解析後的元素序列化回 XML，每個元素自帶 xmlns，用於原樣回送 ReferenceParameters */
export function serializeXml(el: XmlElement): string {
  const attrs = Object.entries(el.attrs)
    .filter(([k]) => !k.startsWith("{"))
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  const xmlns = el.ns ? ` xmlns="${escapeXml(el.ns)}"` : "";
  const inner = el.children.length ? el.children.map(serializeXml).join("") : escapeXml(el.text);
  return `<${el.local}${xmlns}${attrs}>${inner}</${el.local}>`;
}
