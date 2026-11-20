import type { OnvifEndpoint } from "../types.ts";
import { isOnvifError, OnvifError } from "./errors.ts";
import { NS, soapCall, type SoapTransport } from "./soap.ts";
import { child, children, find, path, textOf, type XmlElement } from "./xml.ts";

export interface OnvifServices {
  device: string;
  media: string | null;
  ptz: string | null;
  events: string | null;
}

export interface PtzCapabilities {
  /** 帶 PTZ 設定的 media profile，所有 PTZ 指令都用它 */
  profileToken: string;
  continuous: boolean;
  relative: boolean;
  /** 有 Zoom 軸（持續或相對任一） */
  zoom: boolean;
  /** 相機回報的預置點上限；沒回報時為 null */
  maxPresets: number | null;
}

export interface OnvifCapabilities {
  /** 已改寫成使用者設定主機的服務位址 */
  services: OnvifServices;
  /** 第一個 media profile；沒有 profile 時為 null */
  profileToken: string | null;
  /** 沒有 PTZ 時為 null */
  ptz: PtzCapabilities | null;
  /** 支援 PullPoint 事件 */
  events: boolean;
}

export interface OnvifClientOptions {
  fetch?: typeof fetch;
  /** 本機時鐘（毫秒），測試可注入 */
  now?: () => number;
  /** 單一請求的時間上限 */
  timeoutMs?: number;
}

export type ServiceName = keyof OnvifServices;

export interface CallOptions {
  /** 預設為 true；`GetSystemDateAndTime` 不需驗證 */
  auth?: boolean;
  addressing?: boolean;
  extraHeaders?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** 驗證失敗後重新對時的最短間隔，避免帳密錯誤時每次都多打一次 */
const RESYNC_MIN_INTERVAL_MS = 30_000;

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function effectivePort(u: URL): string {
  return u.port || (u.protocol === "https:" ? "443" : "80");
}

/**
 * 相機回報的位址常是它自己的內網 IP 或主機名稱。一律換成使用者設定的主機；
 * 埠號與相機自己 device 服務的埠相同時換成使用者設定的埠（NAT／轉埠），
 * 其他埠（例如 Tapo 的訂閱位址在 1025）保留原樣。
 */
export function rewriteXAddr(reported: string, endpoint: Pick<OnvifEndpoint, "host" | "port">, devicePort: string): string {
  let u: URL;
  try {
    u = new URL(reported.trim());
  } catch {
    throw new OnvifError("protocol", `相機回報的服務位址無效：${reported}`, "rewriteXAddr");
  }
  const samePortAsDevice = effectivePort(u) === devicePort;
  u.hostname = hostForUrl(endpoint.host);
  if (samePortAsDevice) u.port = String(endpoint.port);
  return u.toString();
}

/** 把 tt:UTCDateTime 轉成毫秒 */
export function parseUtcDateTime(el: XmlElement | undefined): number | null {
  const t = child(el, "Time");
  const d = child(el, "Date");
  const n = (p: XmlElement | undefined, name: string) => Number(textOf(child(p, name)));
  const ms = Date.UTC(n(d, "Year"), n(d, "Month") - 1, n(d, "Day"), n(t, "Hour"), n(t, "Minute"), n(t, "Second"));
  return Number.isFinite(ms) ? ms : null;
}

const SERVICE_BY_NAMESPACE: Record<string, ServiceName> = {
  [NS.tds]: "device",
  [NS.trt]: "media",
  [NS.tptz]: "ptz",
  [NS.tev]: "events",
};

interface RawServices {
  xaddrs: Partial<Record<ServiceName, string>>;
  pullPoint: boolean | null;
}

function parseCapabilities(res: XmlElement): RawServices {
  const caps = child(res, "Capabilities");
  const x = (name: string) => textOf(path(caps, name, "XAddr")) || undefined;
  const pull = textOf(path(caps, "Events", "WSPullPointSupport"));
  return {
    xaddrs: { device: x("Device"), media: x("Media"), ptz: x("PTZ"), events: x("Events") },
    pullPoint: pull === undefined ? null : pull === "true",
  };
}

function parseServices(res: XmlElement): RawServices {
  const out: RawServices = { xaddrs: {}, pullPoint: null };
  for (const svc of children(res, "Service")) {
    const name = SERVICE_BY_NAMESPACE[textOf(child(svc, "Namespace")) ?? ""];
    const xaddr = textOf(child(svc, "XAddr"));
    if (!name || !xaddr) continue;
    out.xaddrs[name] = xaddr;
    if (name === "events") {
      const flag = child(child(svc, "Capabilities"), "Capabilities")?.attrs.WSPullPointSupport;
      if (flag !== undefined) out.pullPoint = flag === "true";
    }
  }
  return out;
}

const SPACE_ELEMENTS = {
  continuous: ["ContinuousPanTiltVelocitySpace", "DefaultContinuousPanTiltVelocitySpace"],
  relative: ["RelativePanTiltTranslationSpace", "DefaultRelativePanTiltTranslationSpace"],
  zoom: [
    "ContinuousZoomVelocitySpace",
    "RelativeZoomTranslationSpace",
    "DefaultContinuousZoomVelocitySpace",
    "DefaultRelativeZoomTranslationSpace",
  ],
} as const;

function hasAny(el: XmlElement | undefined, names: readonly string[]): boolean {
  return names.some((n) => find(el, n) !== undefined);
}

export class OnvifClient {
  readonly endpoint: OnvifEndpoint;
  private readonly transport: SoapTransport;
  private readonly now: () => number;
  private offsetMs = 0;
  private lastSyncAt: number | null = null;
  private probing: Promise<OnvifCapabilities> | null = null;
  private devicePort: string;

  constructor(endpoint: OnvifEndpoint, opts: OnvifClientOptions = {}) {
    this.endpoint = endpoint;
    this.transport = { fetch: opts.fetch ?? fetch, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };
    this.now = opts.now ?? Date.now;
    this.devicePort = String(endpoint.port);
  }

  /** 相機時鐘減本機時鐘（毫秒） */
  get clockOffsetMs(): number {
    return this.offsetMs;
  }

  localNow(): number {
    return this.now();
  }

  /** 換算成相機時鐘的現在時間 */
  cameraNow(): number {
    return this.now() + this.offsetMs;
  }

  /** 把相機時鐘的時間換回本機時鐘 */
  toLocalTime(cameraMs: number): number {
    return cameraMs - this.offsetMs;
  }

  get deviceUrl(): string {
    return `http://${hostForUrl(this.endpoint.host)}:${this.endpoint.port}/onvif/device_service`;
  }

  rewrite(reported: string): string {
    return rewriteXAddr(reported, this.endpoint, this.devicePort);
  }

  /** 能力探測結果會快取；探測失敗不快取，下次呼叫會重新探測 */
  capabilities(): Promise<OnvifCapabilities> {
    if (!this.probing) {
      const p = this.probe();
      this.probing = p;
      p.catch(() => {
        if (this.probing === p) this.probing = null;
      });
    }
    return this.probing;
  }

  /** 捨棄快取並重新探測 */
  refresh(): Promise<OnvifCapabilities> {
    this.probing = null;
    return this.capabilities();
  }

  /** 相機不支援或拒絕未驗證的 GetSystemDateAndTime 時沿用目前的時間差 */
  async syncClock(signal?: AbortSignal): Promise<void> {
    const before = this.now();
    let res: XmlElement;
    try {
      res = await this.callUrl(this.deviceUrl, `${NS.tds}/GetSystemDateAndTime`, "GetSystemDateAndTime",
        `<GetSystemDateAndTime xmlns="${NS.tds}"/>`, { auth: false, signal });
    } catch (err) {
      if (isOnvifError(err, "fault") || isOnvifError(err, "auth")) {
        this.lastSyncAt = this.now();
        return;
      }
      throw err;
    }
    const camera = parseUtcDateTime(path(res, "SystemDateAndTime", "UTCDateTime"));
    this.lastSyncAt = this.now();
    // 相機只給到秒，取請求來回的中點
    if (camera !== null) this.offsetMs = camera - Math.round((before + this.lastSyncAt) / 2);
  }

  /** 對指定服務送出請求；服務位址來自能力探測 */
  async call(service: ServiceName, action: string, name: string, body: string, opts: CallOptions = {}): Promise<XmlElement> {
    const caps = await this.capabilities();
    const url = caps.services[service];
    if (!url) throw new OnvifError("protocol", `${name}：相機沒有 ${service} 服務`, name);
    return this.callUrl(url, action, name, body, opts);
  }

  /** 對任意（已改寫過的）位址送出請求，驗證失敗時重新對時再試一次 */
  async callUrl(url: string, action: string, name: string, body: string, opts: CallOptions = {}): Promise<XmlElement> {
    const send = () =>
      soapCall(
        {
          url,
          action,
          name,
          body,
          credentials: opts.auth === false ? undefined : this.endpoint,
          cameraNow: this.cameraNow(),
          addressing: opts.addressing,
          extraHeaders: opts.extraHeaders,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
        },
        this.transport,
      );
    try {
      return await send();
    } catch (err) {
      // 連不上多半是相機斷電或重開機，回來時時鐘與服務都可能變了；下次呼叫重新探測、重新對時
      if (isOnvifError(err, "unreachable") || isOnvifError(err, "timeout")) {
        this.probing = null;
        this.lastSyncAt = null;
      }
      const stale = this.lastSyncAt === null || this.now() - this.lastSyncAt >= RESYNC_MIN_INTERVAL_MS;
      if (opts.auth === false || !isOnvifError(err, "auth") || !stale) throw err;
      await this.syncClock(opts.signal);
      return send();
    }
  }

  private async probe(): Promise<OnvifCapabilities> {
    await this.syncClock();
    const raw = await this.discoverServices();
    if (raw.xaddrs.device) this.devicePort = effectivePort(new URL(raw.xaddrs.device));
    const xa = (name: ServiceName) => (raw.xaddrs[name] ? this.rewrite(raw.xaddrs[name]) : null);
    const services: OnvifServices = { device: xa("device") ?? this.deviceUrl, media: xa("media"), ptz: xa("ptz"), events: xa("events") };

    let profileToken: string | null = null;
    let ptzProfile: XmlElement | undefined;
    if (services.media) {
      const res = await this.callUrl(services.media, `${NS.trt}/GetProfiles`, "GetProfiles", `<GetProfiles xmlns="${NS.trt}"/>`);
      const profiles = children(res, "Profiles");
      profileToken = profiles[0]?.attrs.token ?? null;
      ptzProfile = profiles.find((p) => child(p, "PTZConfiguration") && p.attrs.token);
    }

    let ptz: PtzCapabilities | null = null;
    if (services.ptz && ptzProfile) {
      const config = child(ptzProfile, "PTZConfiguration");
      const node = await this.ptzNode(services.ptz, textOf(child(config, "NodeToken")));
      const spaces = child(node, "SupportedPTZSpaces") ?? config;
      const max = textOf(child(node, "MaximumNumberOfPresets"));
      ptz = {
        profileToken: ptzProfile.attrs.token!,
        continuous: hasAny(spaces, SPACE_ELEMENTS.continuous),
        relative: hasAny(spaces, SPACE_ELEMENTS.relative),
        zoom: hasAny(spaces, SPACE_ELEMENTS.zoom),
        maxPresets: max && Number.isFinite(Number(max)) ? Number(max) : null,
      };
    }

    return { services, profileToken, ptz, events: Boolean(services.events) && raw.pullPoint !== false };
  }

  private async discoverServices(): Promise<RawServices> {
    try {
      const res = await this.callUrl(this.deviceUrl, `${NS.tds}/GetCapabilities`, "GetCapabilities",
        `<GetCapabilities xmlns="${NS.tds}"><Category>All</Category></GetCapabilities>`);
      return parseCapabilities(res);
    } catch (err) {
      if (!isOnvifError(err, "fault")) throw err;
      const res = await this.callUrl(this.deviceUrl, `${NS.tds}/GetServices`, "GetServices",
        `<GetServices xmlns="${NS.tds}"><IncludeCapability>true</IncludeCapability></GetServices>`);
      return parseServices(res);
    }
  }

  /** GetNodes 失敗時退回 profile 內的預設空間，不讓探測整個失敗 */
  private async ptzNode(url: string, nodeToken: string | undefined): Promise<XmlElement | undefined> {
    try {
      const res = await this.callUrl(url, `${NS.tptz}/GetNodes`, "GetNodes", `<GetNodes xmlns="${NS.tptz}"/>`);
      const nodes = children(res, "PTZNode");
      return nodes.find((n) => n.attrs.token === nodeToken) ?? nodes[0];
    } catch (err) {
      if (isOnvifError(err, "fault")) return undefined;
      throw err;
    }
  }
}
