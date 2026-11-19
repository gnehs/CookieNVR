// 測試用的假 ONVIF 相機。能力、profile、PTZ 節點直接回傳 Tapo 實機 fixture（已去識別化），
// 其餘回應自行產生，並刻意使用和實機不同的命名空間前綴。伺服器端真的驗 UsernameToken digest。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { child, escapeXml, find, parseXml, textOf } from "./xml.ts";

const FIXTURES = join(import.meta.dir, "fixtures/tapo");
/** fixture 裡相機自稱的主機 */
const FIXTURE_HOST = "192.0.2.10";

const ENV = "http://www.w3.org/2003/05/soap-envelope";

export interface FakeFault {
  code?: string;
  subcode: string;
  reason: string;
  status?: number;
}

export interface FakeOnvifOptions {
  username?: string;
  password?: string;
  /** 相機時鐘比真實時間快多少毫秒 */
  clockSkewMs?: number;
  /** Created 與相機時鐘可容許的誤差 */
  createdToleranceMs?: number;
  /** ContinuousMove 回 Fault，模擬只支援相對移動的相機 */
  continuousUnsupported?: boolean;
  renewUnsupported?: boolean;
  /** GetCapabilities 回 Fault，迫使客戶端改用 GetServices */
  capabilitiesUnsupported?: boolean;
  /** 從 GetCapabilities 拿掉的服務，模擬沒有 PTZ 或事件的相機 */
  without?: ("PTZ" | "Events")[];
}

export interface FakeRequest {
  action: string;
  path: string;
  body: string;
  /** Header 裡的 wsa:To */
  to: string | null;
}

interface Subscription {
  id: number;
  terminationAt: number;
  queue: string[];
  wake: (() => void) | null;
}

export interface NotificationSpec {
  topic: string;
  data: Record<string, string>;
  source?: Record<string, string>;
  utcTime?: string;
  operation?: "Initialized" | "Changed" | "Deleted";
}

export function notificationXml(n: NotificationSpec): string {
  const items = (rec: Record<string, string>) =>
    Object.entries(rec).map(([k, v]) => `<o:SimpleItem Name="${escapeXml(k)}" Value="${escapeXml(v)}"/>`).join("");
  const attrs = [n.utcTime ? ` UtcTime="${n.utcTime}"` : "", n.operation ? ` PropertyOperation="${n.operation}"` : ""].join("");
  return (
    `<b:NotificationMessage><b:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${escapeXml(n.topic)}</b:Topic>` +
    `<b:Message><o:Message${attrs}><o:Source>${items(n.source ?? {})}</o:Source><o:Data>${items(n.data)}</o:Data></o:Message></b:Message>` +
    `</b:NotificationMessage>`
  );
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class FakeOnvif {
  readonly requests: FakeRequest[] = [];
  readonly presets = new Map<string, string>();
  /** 每個動作延遲回應的毫秒數，用來測逾時 */
  readonly delays = new Map<string, number>();
  readonly faults = new Map<string, FakeFault>();
  private readonly subs = new Map<number, Subscription>();
  private readonly nonces = new Set<string>();
  private nextSub = 1;
  private nextPreset = 1;
  private device!: ReturnType<typeof Bun.serve>;
  private events!: ReturnType<typeof Bun.serve>;
  private fixtures = new Map<string, string>();

  constructor(readonly opts: FakeOnvifOptions = {}) {}

  get username() {
    return this.opts.username ?? "admin";
  }
  get password() {
    return this.opts.password ?? "p@ss<&>'\"word";
  }
  get port(): number {
    return this.device.port!;
  }
  get eventsPort(): number {
    return this.events.port!;
  }
  get endpoint() {
    return { host: "127.0.0.1", port: this.port, username: this.username, password: this.password };
  }
  cameraNow(): number {
    return Date.now() + (this.opts.clockSkewMs ?? 0);
  }
  actions(): string[] {
    return this.requests.map((r) => r.action);
  }
  activeSubscriptions(): number {
    return this.subs.size;
  }

  async start(): Promise<this> {
    for (const name of ["GetCapabilities", "GetServices", "GetProfiles", "GetNodes", "Fault-NotAuthorized"]) {
      this.fixtures.set(name, await Bun.file(join(FIXTURES, `${name}.xml`)).text());
    }
    const handler = (req: Request) => this.handle(req);
    this.device = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    this.events = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.subs.values()) s.wake?.();
    this.subs.clear();
    await Promise.all([this.device.stop(true), this.events.stop(true)]);
  }

  push(n: NotificationSpec): void {
    for (const s of this.subs.values()) {
      s.queue.push(notificationXml(n));
      s.wake?.();
    }
  }

  /** 模擬相機重開機：所有訂閱失效 */
  dropSubscriptions(): void {
    for (const s of this.subs.values()) s.wake?.();
    this.subs.clear();
  }

  private envelope(body: string, status = 200): Response {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<env:Envelope xmlns:env="${ENV}" xmlns:o="http://www.onvif.org/ver10/schema" xmlns:dev="http://www.onvif.org/ver10/device/wsdl"` +
      ` xmlns:p="http://www.onvif.org/ver20/ptz/wsdl" xmlns:e="http://www.onvif.org/ver10/events/wsdl" xmlns:b="http://docs.oasis-open.org/wsn/b-2"` +
      ` xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:er="http://www.onvif.org/ver10/error">` +
      `<env:Header/><env:Body>${body}</env:Body></env:Envelope>`;
    return new Response(xml, { status, headers: { "Content-Type": "application/soap+xml; charset=utf-8" } });
  }

  private fault(f: FakeFault): Response {
    return this.envelope(
      `<env:Fault><env:Code><env:Value>env:${f.code ?? "Sender"}</env:Value><env:Subcode><env:Value>er:${f.subcode}</env:Value></env:Subcode></env:Code>` +
        `<env:Reason><env:Text xml:lang="en">${escapeXml(f.reason)}</env:Text></env:Reason></env:Fault>`,
      f.status ?? 400,
    );
  }

  /** Tapo fixture 原樣回傳：服務位址是相機自稱的 192.0.2.10:2020，客戶端必須改寫 */
  private fixture(name: string, status = 200): Response {
    return new Response(this.fixtures.get(name)!, { status, headers: { "Content-Type": "application/soap+xml; charset=utf-8" } });
  }

  private checkAuth(header: ReturnType<typeof parseXml> | undefined): boolean {
    const token = find(header, "UsernameToken");
    const user = textOf(child(token, "Username"));
    const digest = textOf(child(token, "Password"));
    const nonce = textOf(child(token, "Nonce"));
    const created = textOf(child(token, "Created"));
    if (!user || !digest || !nonce || !created) return false;
    if (user !== this.username) return false;
    const createdMs = Date.parse(created);
    if (!Number.isFinite(createdMs) || Math.abs(createdMs - this.cameraNow()) > (this.opts.createdToleranceMs ?? 5_000)) return false;
    if (this.nonces.has(nonce)) return false;
    const expected = createHash("sha1").update(Buffer.concat([Buffer.from(nonce, "base64"), Buffer.from(created + this.password, "utf8")])).digest("base64");
    if (expected !== digest) return false;
    this.nonces.add(nonce);
    return true;
  }

  private async handle(req: Request): Promise<Response> {
    const text = await req.text();
    const root = parseXml(text);
    const header = child(root, "Header");
    const op = child(root, "Body")?.children[0];
    const action = op?.local ?? "";
    const url = new URL(req.url);
    this.requests.push({ action, path: url.pathname, body: text, to: textOf(child(header, "To")) ?? null });

    const delay = this.delays.get(action);
    if (delay) await Bun.sleep(delay);
    if (action !== "GetSystemDateAndTime" && !this.checkAuth(header)) return this.fixture("Fault-NotAuthorized", 400);
    const injected = this.faults.get(action);
    if (injected) return this.fault(injected);

    switch (action) {
      case "GetSystemDateAndTime": {
        const d = new Date(this.cameraNow());
        return this.envelope(
          `<dev:GetSystemDateAndTimeResponse><dev:SystemDateAndTime><o:DateTimeType>Manual</o:DateTimeType><o:UTCDateTime>` +
            `<o:Time><o:Hour>${d.getUTCHours()}</o:Hour><o:Minute>${d.getUTCMinutes()}</o:Minute><o:Second>${d.getUTCSeconds()}</o:Second></o:Time>` +
            `<o:Date><o:Year>${d.getUTCFullYear()}</o:Year><o:Month>${d.getUTCMonth() + 1}</o:Month><o:Day>${d.getUTCDate()}</o:Day></o:Date>` +
            `</o:UTCDateTime></dev:SystemDateAndTime></dev:GetSystemDateAndTimeResponse>`,
        );
      }
      case "GetCapabilities":
        if (this.opts.capabilitiesUnsupported) return this.fault({ subcode: "ActionNotSupported", reason: "not supported" });
        if (this.opts.without?.length) {
          let xml = this.fixtures.get("GetCapabilities")!;
          for (const name of this.opts.without) xml = xml.replace(new RegExp(`<tt:${name}>.*?</tt:${name}>`, "s"), "");
          return new Response(xml, { headers: { "Content-Type": "application/soap+xml; charset=utf-8" } });
        }
        return this.fixture("GetCapabilities");
      case "GetServices":
      case "GetProfiles":
      case "GetNodes":
        return this.fixture(action);
      case "ContinuousMove":
        if (this.opts.continuousUnsupported) return this.fault({ code: "Receiver", subcode: "ActionNotSupported", reason: "ContinuousMove not supported" });
        return this.envelope(`<p:ContinuousMoveResponse/>`);
      case "RelativeMove":
      case "Stop":
      case "GotoPreset":
        return this.envelope(`<p:${action}Response/>`);
      case "GetPresets":
        return this.envelope(
          `<p:GetPresetsResponse>${[...this.presets]
            .map(([token, name]) => `<p:Preset token="${escapeXml(token)}"><o:Name><![CDATA[${name}]]></o:Name></p:Preset>`)
            .join("")}</p:GetPresetsResponse>`,
        );
      case "SetPreset": {
        const token = textOf(child(op, "PresetToken")) || `preset-${this.nextPreset++}`;
        this.presets.set(token, textOf(child(op, "PresetName")) ?? "");
        return this.envelope(`<p:SetPresetResponse><p:PresetToken>${escapeXml(token)}</p:PresetToken></p:SetPresetResponse>`);
      }
      case "RemovePreset":
        this.presets.delete(textOf(child(op, "PresetToken")) ?? "");
        return this.envelope(`<p:RemovePresetResponse/>`);
      case "CreatePullPointSubscription": {
        const seconds = Number(/PT(\d+)S/.exec(textOf(child(op, "InitialTerminationTime")) ?? "")?.[1] ?? 60);
        const sub: Subscription = { id: this.nextSub++, terminationAt: this.cameraNow() + seconds * 1000, queue: [], wake: null };
        this.subs.set(sub.id, sub);
        return this.envelope(
          `<e:CreatePullPointSubscriptionResponse><e:SubscriptionReference>` +
            `<a:Address>http://${FIXTURE_HOST}:${this.eventsPort}/event-${sub.id}</a:Address>` +
            `<a:ReferenceParameters><sub xmlns="urn:fake">${sub.id}</sub></a:ReferenceParameters>` +
            `</e:SubscriptionReference><b:CurrentTime>${iso(this.cameraNow())}</b:CurrentTime>` +
            `<b:TerminationTime>${iso(sub.terminationAt)}</b:TerminationTime></e:CreatePullPointSubscriptionResponse>`,
        );
      }
    }

    const sub = this.subs.get(Number(/^\/event-(\d+)$/.exec(url.pathname)?.[1]));
    const refParam = textOf(find(header, "sub"));
    if (!sub || refParam !== String(sub.id) || sub.terminationAt < this.cameraNow()) {
      return this.fault({ subcode: "ResourceUnknownFault", reason: "unknown subscription" });
    }
    switch (action) {
      case "PullMessages": {
        const timeout = Number(/PT(\d+)S/.exec(textOf(child(op, "Timeout")) ?? "")?.[1] ?? 10) * 1000;
        if (!sub.queue.length) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timeout);
            sub.wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
          sub.wake = null;
        }
        if (!this.subs.has(sub.id)) return this.fault({ subcode: "ResourceUnknownFault", reason: "subscription gone" });
        const messages = sub.queue.splice(0);
        return this.envelope(
          `<e:PullMessagesResponse><e:CurrentTime>${iso(this.cameraNow())}</e:CurrentTime>` +
            `<e:TerminationTime>${iso(sub.terminationAt)}</e:TerminationTime>${messages.join("")}</e:PullMessagesResponse>`,
        );
      }
      case "Renew": {
        if (this.opts.renewUnsupported) return this.fault({ code: "Receiver", subcode: "ActionNotSupported", reason: "Renew not supported" });
        const seconds = Number(/PT(\d+)S/.exec(textOf(child(op, "TerminationTime")) ?? "")?.[1] ?? 60);
        sub.terminationAt = this.cameraNow() + seconds * 1000;
        return this.envelope(
          `<b:RenewResponse><b:TerminationTime>${iso(sub.terminationAt)}</b:TerminationTime><b:CurrentTime>${iso(this.cameraNow())}</b:CurrentTime></b:RenewResponse>`,
        );
      }
      case "Unsubscribe":
        this.subs.delete(sub.id);
        sub.wake?.();
        return this.envelope(`<b:UnsubscribeResponse/>`);
    }
    return this.fault({ subcode: "ActionNotSupported", reason: `unknown action ${action}` });
  }
}
