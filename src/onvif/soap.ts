import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OnvifError, type SoapFaultDetail } from "./errors.ts";
import { child, escapeXml, parseXml, path, textOf, XmlParseError, type XmlElement } from "./xml.ts";

// 命名空間依 onvif.org 的 WSDL 與 OASIS WS-N、WS-Security 規格
export const NS = {
  soap: "http://www.w3.org/2003/05/soap-envelope",
  soap11: "http://schemas.xmlsoap.org/soap/envelope/",
  wsse: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
  wsu: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
  wsa: "http://www.w3.org/2005/08/addressing",
  tds: "http://www.onvif.org/ver10/device/wsdl",
  trt: "http://www.onvif.org/ver10/media/wsdl",
  tptz: "http://www.onvif.org/ver20/ptz/wsdl",
  tev: "http://www.onvif.org/ver10/events/wsdl",
  tt: "http://www.onvif.org/ver10/schema",
  wsnt: "http://docs.oasis-open.org/wsn/b-2",
} as const;

const PASSWORD_DIGEST =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest";
const BASE64 = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";

export interface SoapCredentials {
  username: string;
  password: string;
}

export interface SoapTransport {
  fetch: typeof fetch;
  timeoutMs: number;
}

export interface SoapRequest {
  url: string;
  /** SOAP action URI，同時作為 WS-Addressing Action */
  action: string;
  /** 給錯誤訊息用的短名稱 */
  name: string;
  /** Body 內的 XML，命名空間需自行宣告 */
  body: string;
  credentials?: SoapCredentials;
  /** 相機時鐘的現在時間（毫秒），用來產生 Created */
  cameraNow?: number;
  /** 加上 WS-Addressing 標頭（PullPoint 訂閱相關請求需要） */
  addressing?: boolean;
  /** 額外的 Header 子元素，例如訂閱的 ReferenceParameters */
  extraHeaders?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** UsernameToken 的 PasswordDigest = Base64(SHA1(nonce + created + password)) */
export function passwordDigest(nonce: Uint8Array, created: string, password: string): string {
  return createHash("sha1").update(nonce).update(created).update(password).digest("base64");
}

export function formatCreated(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function securityHeader(cred: SoapCredentials, cameraNow: number): string {
  const nonce = randomBytes(16);
  const created = formatCreated(cameraNow);
  const digest = passwordDigest(nonce, created, cred.password);
  return (
    `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" s:mustUnderstand="1">` +
    `<wsse:UsernameToken><wsse:Username>${escapeXml(cred.username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_DIGEST}">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${BASE64}">${nonce.toString("base64")}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
  );
}

function addressingHeaders(req: SoapRequest): string {
  return (
    `<wsa:Action xmlns:wsa="${NS.wsa}">${escapeXml(req.action)}</wsa:Action>` +
    `<wsa:MessageID xmlns:wsa="${NS.wsa}">urn:uuid:${randomUUID()}</wsa:MessageID>` +
    `<wsa:ReplyTo xmlns:wsa="${NS.wsa}"><wsa:Address>${NS.wsa}/anonymous</wsa:Address></wsa:ReplyTo>` +
    `<wsa:To xmlns:wsa="${NS.wsa}">${escapeXml(req.url)}</wsa:To>`
  );
}

export function buildEnvelope(req: SoapRequest): string {
  const headers: string[] = [];
  if (req.credentials) headers.push(securityHeader(req.credentials, req.cameraNow ?? Date.now()));
  if (req.addressing) headers.push(addressingHeaders(req));
  headers.push(...(req.extraHeaders ?? []));
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS.soap}"><s:Header>${headers.join("")}</s:Header>` +
    `<s:Body>${req.body}</s:Body></s:Envelope>`
  );
}

const AUTH_SUBCODES = new Set([
  "NotAuthorized",
  "FailedAuthentication",
  "InvalidSecurity",
  "InvalidSecurityToken",
  "FailedCheck",
  "SecurityTokenUnavailable",
  "MessageExpired",
]);

function stripPrefix(qname: string | undefined): string {
  if (!qname) return "";
  const i = qname.lastIndexOf(":");
  return i < 0 ? qname : qname.slice(i + 1);
}

export function parseFault(fault: XmlElement): SoapFaultDetail {
  // SOAP 1.2：Code/Value + 巢狀 Subcode；SOAP 1.1：faultcode/faultstring
  const code = child(fault, "Code");
  if (code) {
    let subcode: string | null = null;
    let cur = child(code, "Subcode");
    while (cur) {
      subcode = stripPrefix(textOf(child(cur, "Value")));
      cur = child(cur, "Subcode");
    }
    const reason = child(fault, "Reason")?.children.map((t) => t.text.trim()).filter(Boolean)[0] ?? "";
    return { code: stripPrefix(textOf(child(code, "Value"))), subcode, reason };
  }
  return {
    code: stripPrefix(textOf(child(fault, "faultcode"))),
    subcode: null,
    reason: textOf(child(fault, "faultstring")) ?? "",
  };
}

function isAuthFault(f: SoapFaultDetail): boolean {
  if (f.subcode && AUTH_SUBCODES.has(f.subcode)) return true;
  if (AUTH_SUBCODES.has(f.code)) return true;
  return /not\s*authori[sz]ed|authentication|unauthori[sz]ed|sender not authorized/i.test(f.reason);
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("***") : text;
}

/** ONVIF 回應都是幾十 KB；上限擋住壞掉或惡意的裝置一路送資料把主程序的記憶體吃光 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

class ResponseTooLarge extends Error {}

async function readBody(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw new ResponseTooLarge();
  }
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 送出 SOAP 請求並回傳 Body 的第一個子元素 */
export async function soapCall(req: SoapRequest, transport: SoapTransport): Promise<XmlElement> {
  const secret = req.credentials?.password || undefined;
  const fail = (kind: OnvifError["kind"], message: string, fault: SoapFaultDetail | null = null, status: number | null = null) =>
    new OnvifError(kind, redact(`${req.name}：${message}`, secret), req.name, fault, status);

  if (req.signal?.aborted) throw fail("aborted", "已中止");
  const timeoutSignal = AbortSignal.timeout(req.timeoutMs ?? transport.timeoutMs);
  const signal = req.signal ? AbortSignal.any([timeoutSignal, req.signal]) : timeoutSignal;

  let status: number;
  let text: string;
  let res: Response | undefined;
  try {
    res = await transport.fetch(req.url, {
      method: "POST",
      headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${req.action}"` },
      body: buildEnvelope(req),
      signal,
    });
    status = res.status;
    text = await readBody(res);
  } catch (err) {
    if (err instanceof ResponseTooLarge) throw fail("protocol", `回應超過 ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`, null, res?.status ?? null);
    if (req.signal?.aborted) throw fail("aborted", "已中止");
    if (timeoutSignal.aborted) throw fail("timeout", `相機在 ${req.timeoutMs ?? transport.timeoutMs} ms 內沒有回應`);
    const detail = err instanceof Error ? err.message : String(err);
    throw fail("unreachable", `無法連線到 ${new URL(req.url).host}（${detail}）`);
  }

  let root: XmlElement | null = null;
  try {
    root = text.trim() ? parseXml(text) : null;
  } catch (err) {
    if (!(err instanceof XmlParseError)) throw err;
  }
  const body = root?.local === "Envelope" ? child(root, "Body") : undefined;
  const fault = body ? child(body, "Fault") : undefined;
  if (fault) {
    const detail = parseFault(fault);
    const label = [detail.subcode ?? detail.code, detail.reason].filter(Boolean).join("：");
    if (isAuthFault(detail)) throw fail("auth", `驗證失敗（${label}）`, detail, status);
    throw fail("fault", `相機回傳錯誤（${label}）`, detail, status);
  }
  if (status === 401 || status === 403) throw fail("auth", `驗證失敗（HTTP ${status}）`, null, status);
  // 經過 HTTP proxy 時，連不上相機會變成閘道錯誤而不是連線例外
  if (!body && (status === 502 || status === 503 || status === 504)) {
    throw fail("unreachable", `無法連線到 ${new URL(req.url).host}（HTTP ${status}）`, null, status);
  }
  if (status < 200 || status >= 300) throw fail("protocol", `HTTP ${status}`, null, status);
  const first = body?.children[0];
  if (!first) throw fail("protocol", "回應不是有效的 SOAP", null, status);
  return first;
}

export function requireText(el: XmlElement | undefined, name: string, ...locals: string[]): string {
  const v = textOf(path(el, ...locals));
  if (!v) throw new OnvifError("protocol", `${name}：回應缺少 ${locals.join("/")}`, name);
  return v;
}
