import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OnvifClient } from "./client.ts";
import {
  createPullPoint,
  normalizeTopic,
  parseNotification,
  pullMessages,
  renew,
  startPullPointSubscriber,
  unsubscribe,
  type OnvifEvent,
  type SubscriberStatus,
} from "./events.ts";
import { FakeOnvif, notificationXml } from "./fake-onvif.ts";
import { children, parseXml, path } from "./xml.ts";

const FIXTURES = join(import.meta.dir, "fixtures/tapo");

let fake: FakeOnvif | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function setup(opts: ConstructorParameters<typeof FakeOnvif>[0] = {}) {
  fake = await new FakeOnvif(opts).start();
  return { f: fake, client: new OnvifClient(fake.endpoint) };
}

async function waitFor(cond: () => boolean, ms = 5_000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await Bun.sleep(10);
  expect(cond()).toBe(true);
}

/**
 * 實機 60 秒內沒有觸發任何事件，所以把通知訊息插進實機的 PullMessages 回應（真實的信封與前綴），
 * 訊息內容依實機 GetEventProperties 宣告的主題與欄位。
 */
async function tapoPullResponse(messages: string[]) {
  const xml = await Bun.file(join(FIXTURES, "PullMessages.xml")).text();
  return parseXml(xml.replace("</tev:PullMessagesResponse>", `${messages.join("")}</tev:PullMessagesResponse>`));
}

function tapoMessage(topic: string, item: string, value: string, utc = "2026-11-19T04:58:10Z") {
  return (
    `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic>` +
    `<wsnt:Message><tt:Message UtcTime="${utc}" PropertyOperation="Changed"><tt:Source>` +
    `<tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsconf"/><tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="VideoAnalyticsToken"/>` +
    `<tt:SimpleItem Name="Rule" Value="MyMotionDetectorRule"/></tt:Source>` +
    `<tt:Data><tt:SimpleItem Name="${item}" Value="${value}"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`
  );
}

describe("parseNotification", () => {
  const identity = (t: number) => t;

  test("Tapo 的主題轉成統一事件", async () => {
    const res = await tapoPullResponse([
      tapoMessage("tns1:RuleEngine/CellMotionDetector/Motion", "IsMotion", "true"),
      tapoMessage("tns1:RuleEngine/PeopleDetector/People", "IsPeople", "false"),
      tapoMessage("tns1:RuleEngine/TamperDetector/Tamper", "IsTamper", "true"),
      tapoMessage("tns1:RuleEngine/LineCrossDetector/LineCross", "IsLineCross", "true"),
      tapoMessage("tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent", "IsTPSmartEvent", "true"),
    ]);
    const events = children(path(res, "Body", "PullMessagesResponse"), "NotificationMessage").map((m) => parseNotification(m, identity, 0));
    expect(events.map((e) => [e.kind, e.active, e.topic])).toEqual([
      ["motion", true, "RuleEngine/CellMotionDetector/Motion"],
      ["person", false, "RuleEngine/PeopleDetector/People"],
      ["tamper", true, "RuleEngine/TamperDetector/Tamper"],
      ["line-crossing", true, "RuleEngine/LineCrossDetector/LineCross"],
      ["unknown", true, "RuleEngine/TPSmartEventDetector/TPSmartEvent"],
    ]);
    expect(events[0]).toMatchObject({
      at: Date.parse("2026-11-19T04:58:10Z"),
      operation: "changed",
      source: { VideoSourceConfigurationToken: "vsconf", Rule: "MyMotionDetectorRule" },
      data: { IsMotion: "true" },
    });
  });

  test("只用 State 的主題（VideoSource/MotionAlarm）依主題判斷", () => {
    const msg = parseXml(
      `<w xmlns:b="http://docs.oasis-open.org/wsn/b-2" xmlns:o="http://www.onvif.org/ver10/schema">` +
        notificationXml({ topic: "tns1:VideoSource/MotionAlarm", data: { State: "1" }, operation: "Initialized" }) +
        `</w>`,
    ).children[0]!;
    expect(parseNotification(msg, identity, 123)).toMatchObject({ kind: "motion", active: true, operation: "initialized", at: 123 });
  });

  test("未知主題保留原始名稱，找不到布林值時 active 為 null", () => {
    const msg = parseXml(
      `<w xmlns:b="http://docs.oasis-open.org/wsn/b-2" xmlns:o="http://www.onvif.org/ver10/schema">` +
        notificationXml({ topic: "tns1:Device/Trigger/Relay", data: { LogicalState: "active" } }) +
        `</w>`,
    ).children[0]!;
    expect(parseNotification(msg, identity, 0)).toMatchObject({ kind: "unknown", active: null, topic: "Device/Trigger/Relay", operation: null });
  });

  test("相機時間換回本機時鐘", () => {
    const msg = parseXml(
      `<w xmlns:b="http://docs.oasis-open.org/wsn/b-2" xmlns:o="http://www.onvif.org/ver10/schema">` +
        notificationXml({ topic: "x:A", data: { IsMotion: "true" }, utcTime: "2026-01-01T03:00:00Z" }) +
        `</w>`,
    ).children[0]!;
    expect(parseNotification(msg, (t) => t - 3600_000, 0).at).toBe(Date.parse("2026-01-01T02:00:00Z"));
  });

  test("主題每一段的前綴都去掉", () => {
    expect(normalizeTopic(" tns1:RuleEngine/tnsaxis:Foo/Bar ")).toBe("RuleEngine/Foo/Bar");
  });
});

describe("PullPoint 訂閱", () => {
  test("訂閱位址改寫成設定的主機，保留相機給的另一個埠，並回送 ReferenceParameters", async () => {
    const { f, client } = await setup();
    const sub = await createPullPoint(client, { terminationSeconds: 30 });
    expect(sub.address).toBe(`http://127.0.0.1:${f.eventsPort}/event-1`);
    f.push({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", data: { IsMotion: "true" } });
    const res = await pullMessages(client, sub, { timeoutSeconds: 1 });
    expect(res.events.map((e) => [e.kind, e.active])).toEqual([["motion", true]]);
    const pull = f.requests.find((r) => r.action === "PullMessages")!;
    expect(pull.to).toBe(sub.address);
    await unsubscribe(client, sub);
    expect(f.activeSubscriptions()).toBe(0);
  });

  test("相機時鐘偏差時，到期時間仍換算成本機時鐘", async () => {
    const { client } = await setup({ clockSkewMs: 5 * 3600_000 });
    const sub = await createPullPoint(client, { terminationSeconds: 60 });
    expect(Math.abs(sub.terminationAt - (Date.now() + 60_000))).toBeLessThan(2_000);
    const later = await renew(client, sub, 120);
    expect(Math.abs(later - (Date.now() + 120_000))).toBeLessThan(2_000);
  });

  test("沒有訊息時長輪詢等滿 Timeout", async () => {
    const { client } = await setup();
    const sub = await createPullPoint(client);
    const t = Date.now();
    expect((await pullMessages(client, sub, { timeoutSeconds: 1 })).events).toEqual([]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });
});

describe("startPullPointSubscriber", () => {
  function run(client: OnvifClient, extra: Partial<Parameters<typeof startPullPointSubscriber>[0]> = {}) {
    const events: OnvifEvent[] = [];
    const statuses: SubscriberStatus[] = [];
    const sub = startPullPointSubscriber({
      client,
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      pullTimeoutSeconds: 1,
      subscriptionSeconds: 3,
      renewMarginMs: 2_000,
      backoffInitialMs: 20,
      backoffMaxMs: 100,
      ...extra,
    });
    return { sub, events, statuses };
  }

  test("收事件、到期前續約、停止時取消訂閱", async () => {
    const { f, client } = await setup();
    const { sub, events, statuses } = run(client);
    await waitFor(() => sub.status().state === "active");
    f.push({ topic: "tns1:RuleEngine/PeopleDetector/People", data: { IsPeople: "true" } });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "person", active: true });
    await waitFor(() => f.actions().includes("Renew"));
    const t = Date.now();
    await sub.stop();
    expect(Date.now() - t).toBeLessThan(500);
    expect(f.actions().at(-1)).toBe("Unsubscribe");
    expect(f.activeSubscriptions()).toBe(0);
    expect(statuses.map((s) => s.state)).toEqual(["connecting", "active", "stopped"]);
  });

  test("相機不支援 Renew 時，到期前建立新訂閱再取消舊的", async () => {
    const { f, client } = await setup({ renewUnsupported: true });
    const { sub, events } = run(client);
    await waitFor(() => f.actions().filter((a) => a === "CreatePullPointSubscription").length >= 2);
    await waitFor(() => f.actions().includes("Unsubscribe"));
    expect(f.activeSubscriptions()).toBe(1);
    expect(sub.status().state).toBe("active");
    f.push({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", data: { IsMotion: "false" } });
    await waitFor(() => events.length === 1);
    await sub.stop();
  });

  test("訂閱失效時退避後重新訂閱", async () => {
    const { f, client } = await setup();
    const { sub, events, statuses } = run(client, { subscriptionSeconds: 60 });
    await waitFor(() => sub.status().state === "active");
    f.dropSubscriptions();
    await waitFor(() => statuses.some((s) => s.state === "backoff"));
    await waitFor(() => f.activeSubscriptions() === 1 && sub.status().state === "active");
    const backoff = statuses.find((s) => s.state === "backoff");
    expect(backoff).toMatchObject({ attempt: 1, error: { kind: "fault" } });
    f.push({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", data: { IsMotion: "true" } });
    await waitFor(() => events.length === 1);
    await sub.stop();
  });

  test("連不上時退避時間逐次加倍到上限，可隨時停止", async () => {
    const { f, client } = await setup();
    await client.capabilities();
    await f.stop();
    fake = null;
    const delays: number[] = [];
    const { sub, statuses } = run(client, {
      onStatus: (s) => {
        statuses.push(s);
        if (s.state === "backoff") delays.push(s.retryAt - Date.now());
      },
    });
    await waitFor(() => delays.length >= 5);
    expect(delays.slice(0, 5).map((d) => Math.round(d / 10) * 10)).toEqual([20, 40, 80, 100, 100]);
    const last = statuses.findLast((s) => s.state === "backoff");
    expect(last).toMatchObject({ error: { kind: "unreachable" } });
    await sub.stop();
    expect(sub.status().state).toBe("stopped");
  });

  test("相機不支援事件時回報 unsupported 並結束", async () => {
    const { f, client } = await setup({ without: ["Events"] });
    const { sub } = run(client);
    await waitFor(() => sub.status().state === "unsupported");
    await sub.stop();
    expect(sub.status().state).toBe("unsupported");
    expect(f.actions()).not.toContain("CreatePullPointSubscription");
  });

  test("onEvent 丟例外不會中斷訂閱", async () => {
    const { f, client } = await setup();
    let calls = 0;
    const sub = startPullPointSubscriber({
      client,
      pullTimeoutSeconds: 1,
      onEvent: () => {
        calls++;
        throw new Error("boom");
      },
    });
    await waitFor(() => sub.status().state === "active");
    f.push({ topic: "a:B", data: { IsMotion: "true" } });
    f.push({ topic: "a:B", data: { IsMotion: "false" } });
    await waitFor(() => calls === 2);
    expect(sub.status().state).toBe("active");
    await sub.stop();
  });
});

describe("Tapo 實機 fixture", () => {
  test("訂閱回應與空的 PullMessages 能被解析", async () => {
    const sub = parseXml(await Bun.file(join(FIXTURES, "CreatePullPointSubscription.xml")).text());
    expect(path(sub, "Body", "CreatePullPointSubscriptionResponse", "SubscriptionReference", "Address")?.text).toMatch(
      /^http:\/\/192\.0\.2\.10:\d+\/event-\d+_\d+$/,
    );
    const pull = parseXml(await Bun.file(join(FIXTURES, "PullMessages.xml")).text());
    expect(children(path(pull, "Body", "PullMessagesResponse"), "NotificationMessage")).toEqual([]);
  });
});
