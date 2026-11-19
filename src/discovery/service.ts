import { sameName, TYPE, type DnsMessage, type DnsRecord } from "./dns.ts";

export const SERVICE_TYPE = "_cookienvr._tcp.local";
const META_QUERY = "_services._dns-sd._udp.local";
// RFC 6762 §10 建議值：主機相關紀錄 120 秒，其他 75 分鐘
const HOST_TTL = 120;
const OTHER_TTL = 4500;

export interface ServiceInfo {
  /** 服務實例名稱（單一 label，不含服務類型） */
  instance: string;
  /** 例如 `cookienvr-1a2b3c4d.local` */
  host: string;
  port: number;
  txt: Record<string, string>;
}

const utf8 = new TextEncoder();

/** 實例名稱是一個 DNS label：最長 63 bytes、不能有點（我們不做跳脫） */
export function instanceLabel(siteName: string, instanceId: string): string {
  const suffix = ` (${instanceId.replace(/-/g, "").slice(0, 4)})`;
  let base = siteName.replace(/[.\p{C}]/gu, " ").trim() || "CookieNVR";
  while (utf8.encode(base + suffix).length > 63) base = [...base].slice(0, -1).join("");
  return base + suffix;
}

export function hostLabel(instanceId: string): string {
  return `cookienvr-${instanceId.replace(/-/g, "").slice(0, 8).toLowerCase()}.local`;
}

export function instanceFqdn(info: ServiceInfo): string {
  return `${info.instance}.${SERVICE_TYPE}`;
}

interface Records {
  meta: DnsRecord;
  ptr: DnsRecord;
  srv: DnsRecord;
  txt: DnsRecord;
  a: DnsRecord;
}

function records(info: ServiceInfo, address: string, goodbye: boolean): Records {
  const ttl = (t: number) => (goodbye ? 0 : t);
  const fqdn = instanceFqdn(info);
  return {
    meta: { type: "PTR", name: META_QUERY, ttl: ttl(OTHER_TTL), cacheFlush: false, target: SERVICE_TYPE },
    ptr: { type: "PTR", name: SERVICE_TYPE, ttl: ttl(OTHER_TTL), cacheFlush: false, target: fqdn },
    srv: { type: "SRV", name: fqdn, ttl: ttl(HOST_TTL), cacheFlush: true, priority: 0, weight: 0, port: info.port, target: info.host },
    txt: {
      type: "TXT",
      name: fqdn,
      ttl: ttl(OTHER_TTL),
      cacheFlush: true,
      entries: Object.entries(info.txt).map(([k, v]) => `${k}=${v}`),
    },
    a: { type: "A", name: info.host, ttl: ttl(HOST_TTL), cacheFlush: true, address },
  };
}

/** 開機與位址變更時主動送出；goodbye 為 TTL 0，讓別人立刻忘掉這台 */
export function announcement(info: ServiceInfo, address: string, goodbye = false): DnsMessage {
  const r = records(info, address, goodbye);
  return { id: 0, isResponse: true, questions: [], answers: [r.ptr, r.srv, r.txt, r.a], additionals: [] };
}

function wants(type: number, ...accepted: number[]): boolean {
  return type === TYPE.ANY || accepted.includes(type);
}

/** 查詢端已經知道、且剩餘 TTL 超過一半的答案就不必再送（RFC 6762 §7.1） */
function alreadyKnown(query: DnsMessage, record: DnsRecord): boolean {
  if (record.type !== "PTR") return false;
  return query.answers.some(
    (k) => k.type === "PTR" && sameName(k.name, record.name) && sameName(k.target, record.target) && k.ttl * 2 >= record.ttl,
  );
}

/**
 * 依查詢組出回應；沒有任何問題與我們有關時回傳 null。
 * `legacy` 為非 5353 埠送來的一般 DNS 查詢：回應要帶原 id 與問題，且 TTL 不得超過 10 秒（RFC 6762 §6.7）。
 */
export function answerQuery(query: DnsMessage, info: ServiceInfo, address: string, legacy = false): DnsMessage | null {
  if (query.isResponse) return null;
  const r = records(info, address, false);
  const fqdn = instanceFqdn(info);
  const answers: DnsRecord[] = [];
  const additionals: DnsRecord[] = [];
  const add = (list: DnsRecord[], rec: DnsRecord) => {
    if (!list.includes(rec)) list.push(rec);
  };

  for (const q of query.questions) {
    if (sameName(q.name, META_QUERY) && wants(q.type, TYPE.PTR)) {
      if (!alreadyKnown(query, r.meta)) add(answers, r.meta);
    } else if (sameName(q.name, SERVICE_TYPE) && wants(q.type, TYPE.PTR)) {
      if (alreadyKnown(query, r.ptr)) continue;
      add(answers, r.ptr);
      for (const extra of [r.srv, r.txt, r.a]) add(additionals, extra);
    } else if (sameName(q.name, fqdn)) {
      if (wants(q.type, TYPE.SRV)) add(answers, r.srv);
      if (wants(q.type, TYPE.TXT)) add(answers, r.txt);
      if (wants(q.type, TYPE.SRV)) add(additionals, r.a);
    } else if (sameName(q.name, info.host) && wants(q.type, TYPE.A)) {
      add(answers, r.a);
    }
  }
  if (answers.length === 0) return null;

  const extras = additionals.filter((rec) => !answers.includes(rec));
  if (!legacy) return { id: 0, isResponse: true, questions: [], answers, additionals: extras };
  const clamp = (rec: DnsRecord): DnsRecord => ({ ...rec, ttl: Math.min(rec.ttl, 10), cacheFlush: false });
  return { id: query.id, isResponse: true, questions: query.questions, answers: answers.map(clamp), additionals: extras.map(clamp) };
}
