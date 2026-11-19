import type { OnvifClient } from "./client.ts";
import { isOnvifError, OnvifError } from "./errors.ts";
import { NS } from "./soap.ts";
import { child, children, path, serializeXml, textOf, type XmlElement } from "./xml.ts";

export type OnvifEventKind = "motion" | "person" | "vehicle" | "pet" | "tamper" | "line-crossing" | "unknown";

export interface OnvifEvent {
  kind: OnvifEventKind;
  /** 狀態值；未知主題找不到布林值時為 null */
  active: boolean | null;
  /** 本機時鐘的毫秒（已扣掉相機時間差） */
  at: number;
  /** 去掉命名空間前綴的主題，例如 `RuleEngine/CellMotionDetector/Motion` */
  topic: string;
  /** ONVIF 的 PropertyOperation：訂閱開始時的初始狀態為 initialized */
  operation: "initialized" | "changed" | "deleted" | null;
  source: Record<string, string>;
  data: Record<string, string>;
}

// Data 裡的布林項目名稱比主題名稱可靠：各家主題路徑不同，但多半沿用這些名稱
const KIND_BY_DATA_ITEM: Record<string, Exclude<OnvifEventKind, "unknown">> = {
  IsMotion: "motion",
  IsPeople: "person",
  IsPerson: "person",
  IsHuman: "person",
  IsVehicle: "vehicle",
  IsCar: "vehicle",
  IsPet: "pet",
  IsDog: "pet",
  IsCat: "pet",
  IsTamper: "tamper",
  IsLineCross: "line-crossing",
};

// 只用 State 之類通用名稱的主題
const KIND_BY_TOPIC: [RegExp, Exclude<OnvifEventKind, "unknown">][] = [
  [/(^|\/)MotionAlarm$/, "motion"],
  [/(^|\/)CellMotionDetector\/Motion$/, "motion"],
  [/(^|\/)PeopleDetector\/People$/, "person"],
  [/(^|\/)TamperDetector\/Tamper$/, "tamper"],
  [/(^|\/)LineCrossDetector\/LineCross$/, "line-crossing"],
];

function parseBool(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return null;
}

export function normalizeTopic(raw: string): string {
  return raw
    .trim()
    .split("/")
    .map((seg) => seg.slice(seg.indexOf(":") + 1))
    .join("/");
}

function simpleItems(el: XmlElement | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of children(el, "SimpleItem")) {
    if (item.attrs.Name !== undefined) out[item.attrs.Name] = item.attrs.Value ?? "";
  }
  return out;
}

const OPERATIONS = { Initialized: "initialized", Changed: "changed", Deleted: "deleted" } as const;

/** 解析一個 wsnt:NotificationMessage */
export function parseNotification(msg: XmlElement, toLocalTime: (cameraMs: number) => number, now: number): OnvifEvent {
  const topic = normalizeTopic(textOf(child(msg, "Topic")) ?? "");
  const inner = child(child(msg, "Message"), "Message");
  const source = simpleItems(child(inner, "Source"));
  const data = simpleItems(child(inner, "Data"));
  const utc = inner?.attrs.UtcTime ? Date.parse(inner.attrs.UtcTime) : NaN;
  const op = inner?.attrs.PropertyOperation as keyof typeof OPERATIONS | undefined;

  let kind: OnvifEventKind = "unknown";
  let active: boolean | null = null;
  for (const [name, value] of Object.entries(data)) {
    const mapped = KIND_BY_DATA_ITEM[name];
    if (mapped) {
      kind = mapped;
      active = parseBool(value);
      break;
    }
  }
  if (kind === "unknown") {
    kind = KIND_BY_TOPIC.find(([re]) => re.test(topic))?.[1] ?? "unknown";
    active = Object.values(data).map(parseBool).find((b) => b !== null) ?? null;
  }

  return {
    kind,
    active,
    at: Number.isFinite(utc) ? toLocalTime(utc) : now,
    topic,
    operation: (op && OPERATIONS[op]) ?? null,
    source,
    data,
  };
}

export interface PullPointSubscription {
  /** 已改寫成使用者設定主機的訂閱位址 */
  address: string;
  /** 需要原樣放進後續請求 Header 的 ReferenceParameters */
  referenceHeaders: string[];
  /** 訂閱到期時間（本機時鐘毫秒） */
  terminationAt: number;
}

const ACTIONS = {
  create: `${NS.tev}/EventPortType/CreatePullPointSubscriptionRequest`,
  pull: `${NS.tev}/PullPointSubscription/PullMessagesRequest`,
  renew: "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest",
  unsubscribe: "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest",
} as const;

/** CurrentTime 與 TerminationTime 都是相機時鐘，相減後換到本機時鐘 */
function terminationFrom(res: XmlElement, client: OnvifClient, name: string): number {
  const term = Date.parse(textOf(child(res, "TerminationTime")) ?? "");
  if (!Number.isFinite(term)) throw new OnvifError("protocol", `${name}：回應缺少 TerminationTime`, name);
  const current = Date.parse(textOf(child(res, "CurrentTime")) ?? "");
  return Number.isFinite(current) ? client.localNow() + (term - current) : client.toLocalTime(term);
}

export async function createPullPoint(client: OnvifClient, opts: { terminationSeconds?: number; signal?: AbortSignal } = {}): Promise<PullPointSubscription> {
  const name = "CreatePullPointSubscription";
  const res = await client.call(
    "events",
    ACTIONS.create,
    name,
    `<${name} xmlns="${NS.tev}"><InitialTerminationTime>PT${opts.terminationSeconds ?? 60}S</InitialTerminationTime></${name}>`,
    { addressing: true, signal: opts.signal },
  );
  const ref = child(res, "SubscriptionReference");
  const address = textOf(child(ref, "Address"));
  if (!address) throw new OnvifError("protocol", `${name}：回應缺少訂閱位址`, name);
  return {
    address: client.rewrite(address),
    referenceHeaders: child(ref, "ReferenceParameters")?.children.map(serializeXml) ?? [],
    terminationAt: terminationFrom(res, client, name),
  };
}

function subCall(client: OnvifClient, sub: PullPointSubscription, action: string, name: string, body: string, opts: { timeoutMs?: number; signal?: AbortSignal }) {
  return client.callUrl(sub.address, action, name, body, {
    addressing: true,
    extraHeaders: sub.referenceHeaders,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
}

export interface PullResult {
  events: OnvifEvent[];
  terminationAt: number;
}

/** 長輪詢：相機最多等 timeoutSeconds 才回應，請求時間上限會自動加上這段時間 */
export async function pullMessages(
  client: OnvifClient,
  sub: PullPointSubscription,
  opts: { timeoutSeconds?: number; limit?: number; requestTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PullResult> {
  const seconds = opts.timeoutSeconds ?? 10;
  const res = await subCall(client, sub, ACTIONS.pull, "PullMessages",
    `<PullMessages xmlns="${NS.tev}"><Timeout>PT${seconds}S</Timeout><MessageLimit>${opts.limit ?? 100}</MessageLimit></PullMessages>`,
    { timeoutMs: seconds * 1000 + (opts.requestTimeoutMs ?? 8_000), signal: opts.signal });
  const now = client.localNow();
  return {
    events: children(res, "NotificationMessage").map((m) => parseNotification(m, (t) => client.toLocalTime(t), now)),
    terminationAt: terminationFrom(res, client, "PullMessages"),
  };
}

export async function renew(client: OnvifClient, sub: PullPointSubscription, seconds: number, signal?: AbortSignal): Promise<number> {
  const res = await subCall(client, sub, ACTIONS.renew, "Renew",
    `<Renew xmlns="${NS.wsnt}"><TerminationTime>PT${seconds}S</TerminationTime></Renew>`, { signal });
  return terminationFrom(res, client, "Renew");
}

export async function unsubscribe(client: OnvifClient, sub: PullPointSubscription, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  await subCall(client, sub, ACTIONS.unsubscribe, "Unsubscribe", `<Unsubscribe xmlns="${NS.wsnt}"/>`, opts);
}

export type SubscriberStatus =
  | { state: "connecting"; attempt: number }
  | { state: "active"; since: number; terminationAt: number }
  | { state: "backoff"; error: OnvifError; attempt: number; retryAt: number }
  /** 相機不支援 PullPoint 事件，訂閱器已結束 */
  | { state: "unsupported" }
  | { state: "stopped" };

export interface PullPointSubscriberOptions {
  client: OnvifClient;
  onEvent: (event: OnvifEvent) => void;
  onStatus?: (status: SubscriberStatus) => void;
  /** 每次 PullMessages 的長輪詢秒數 */
  pullTimeoutSeconds?: number;
  /** 建立與續約時要求的訂閱長度 */
  subscriptionSeconds?: number;
  /** 到期前多久續約 */
  renewMarginMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
}

export interface PullPointSubscriber {
  status(): SubscriberStatus;
  /** 停止輪詢並盡力取消訂閱；可重複呼叫 */
  stop(): Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function asOnvifError(err: unknown): OnvifError {
  if (err instanceof OnvifError) return err;
  return new OnvifError("protocol", err instanceof Error ? err.message : String(err), "subscriber");
}

/** 長時間運作的 PullPoint 訂閱：自動續約；出錯時以指數退避重新建立訂閱 */
export function startPullPointSubscriber(opts: PullPointSubscriberOptions): PullPointSubscriber {
  const { client } = opts;
  const now = opts.now ?? Date.now;
  const pullSeconds = opts.pullTimeoutSeconds ?? 10;
  const subSeconds = opts.subscriptionSeconds ?? 60;
  const renewMargin = opts.renewMarginMs ?? pullSeconds * 1000 + 10_000;
  const backoffInitial = opts.backoffInitialMs ?? 1_000;
  const backoffMax = opts.backoffMaxMs ?? 60_000;
  const abort = new AbortController();
  const signal = abort.signal;
  let status: SubscriberStatus = { state: "connecting", attempt: 0 };
  let current: PullPointSubscription | null = null;

  const setStatus = (s: SubscriberStatus) => {
    status = s;
    opts.onStatus?.(s);
  };
  const dropSubscription = async () => {
    const sub = current;
    current = null;
    if (sub) await unsubscribe(client, sub, { timeoutMs: 3_000 }).catch(() => {});
  };
  const emit = (e: OnvifEvent) => {
    try {
      opts.onEvent(e);
    } catch {
      // 呼叫端的錯誤不該中斷訂閱
    }
  };

  const run = async () => {
    let attempt = 0;
    let reprobe = false;
    while (!signal.aborted) {
      try {
        setStatus({ state: "connecting", attempt });
        const caps = await (reprobe ? client.refresh() : client.capabilities());
        reprobe = false;
        if (!caps.events) {
          setStatus({ state: "unsupported" });
          return;
        }
        current = await createPullPoint(client, { terminationSeconds: subSeconds, signal });
        setStatus({ state: "active", since: now(), terminationAt: current.terminationAt });
        let renewSupported = true;
        while (!signal.aborted) {
          if (current.terminationAt - now() < renewMargin) {
            if (renewSupported) {
              try {
                current.terminationAt = await renew(client, current, subSeconds, signal);
              } catch (err) {
                // 訂閱已失效（ResourceUnknown）走重新連線；其他 Fault 視為相機不支援 Renew
                if (!isOnvifError(err, "fault") || /ResourceUnknown/.test(err.fault?.subcode ?? "")) throw err;
                renewSupported = false;
              }
            }
            if (!renewSupported) {
              // 不支援 Renew 的相機：先建新訂閱再取消舊的，避免漏掉事件
              const old = current;
              current = await createPullPoint(client, { terminationSeconds: subSeconds, signal });
              await unsubscribe(client, old, { timeoutMs: 3_000 }).catch(() => {});
            }
          }
          const res = await pullMessages(client, current, { timeoutSeconds: pullSeconds, signal });
          current.terminationAt = res.terminationAt;
          attempt = 0;
          if (status.state !== "active") setStatus({ state: "active", since: now(), terminationAt: res.terminationAt });
          for (const e of res.events) emit(e);
        }
      } catch (err) {
        if (signal.aborted) break;
        await dropSubscription();
        // 帳密或位址可能剛被修正，下一輪重新探測
        reprobe = isOnvifError(err, "auth") || isOnvifError(err, "unreachable");
        attempt += 1;
        const delay = Math.min(backoffMax, backoffInitial * 2 ** (attempt - 1));
        setStatus({ state: "backoff", error: asOnvifError(err), attempt, retryAt: now() + delay });
        await sleep(delay, signal);
      }
    }
  };

  const loop = run().finally(async () => {
    await dropSubscription();
    if (status.state !== "unsupported") setStatus({ state: "stopped" });
  });

  return {
    status: () => status,
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}
