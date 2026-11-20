import { afterEach, describe, expect, test } from "bun:test";
import { OnvifClient, rewriteXAddr } from "./client.ts";
import { isOnvifError, OnvifError } from "./errors.ts";
import { FakeOnvif } from "./fake-onvif.ts";
import { getPresets } from "./ptz.ts";
import { NS, soapCall } from "./soap.ts";

let fake: FakeOnvif | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function start(opts: ConstructorParameters<typeof FakeOnvif>[0] = {}) {
  fake = await new FakeOnvif(opts).start();
  return fake;
}

async function rejection(p: Promise<unknown>): Promise<OnvifError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OnvifError) return err;
    throw err;
  }
  throw new Error("預期失敗卻成功");
}

describe("rewriteXAddr", () => {
  const ep = { host: "cam.home", port: 12020 };
  test("主機一律換成使用者設定的；與 device 服務同埠時連埠號一起換", () => {
    expect(rewriteXAddr("http://192.168.1.5:2020/onvif/service", ep, "2020")).toBe("http://cam.home:12020/onvif/service");
  });
  test("其他埠保留（Tapo 的訂閱位址在另一個埠）", () => {
    expect(rewriteXAddr("http://192.168.1.5:1024/event-1024_1024", ep, "2020")).toBe("http://cam.home:1024/event-1024_1024");
  });
  test("沒寫埠號視為 80", () => {
    expect(rewriteXAddr("http://10.0.0.2/onvif/ptz", { host: "10.0.0.9", port: 8080 }, "80")).toBe("http://10.0.0.9:8080/onvif/ptz");
  });
  test("IPv6 主機加上方括號", () => {
    expect(rewriteXAddr("http://10.0.0.2:2020/x", { host: "fe80::1", port: 2020 }, "2020")).toBe("http://[fe80::1]:2020/x");
  });
  test("無效位址回報 protocol 錯誤", () => {
    expect(() => rewriteXAddr("not a url", ep, "2020")).toThrow(OnvifError);
  });
});

describe("OnvifClient 能力探測", () => {
  test("Tapo 實機格式：找出服務位址、profile、PTZ 移動方式與事件", async () => {
    const f = await start();
    const client = new OnvifClient(f.endpoint);
    const caps = await client.capabilities();
    const base = `http://127.0.0.1:${f.port}/onvif/service`;
    expect(caps).toEqual({
      services: { device: base, media: base, ptz: base, events: base },
      profileToken: "profile_1",
      ptz: { profileToken: "profile_1", continuous: true, relative: true, zoom: false, maxPresets: 8 },
      events: true,
    });
    expect(f.actions()).toEqual(["GetSystemDateAndTime", "GetCapabilities", "GetProfiles", "GetNodes"]);
  });

  test("結果會快取，refresh 才重新探測", async () => {
    const f = await start();
    const client = new OnvifClient(f.endpoint);
    await client.capabilities();
    await client.capabilities();
    expect(f.actions().filter((a) => a === "GetProfiles")).toHaveLength(1);
    await client.refresh();
    expect(f.actions().filter((a) => a === "GetProfiles")).toHaveLength(2);
  });

  test("探測失敗不快取，下次呼叫會重新探測", async () => {
    const f = await start();
    f.faults.set("GetProfiles", { code: "Receiver", subcode: "Busy", reason: "busy" });
    const client = new OnvifClient(f.endpoint);
    expect((await rejection(client.capabilities())).kind).toBe("fault");
    f.faults.clear();
    expect((await client.capabilities()).profileToken).toBe("profile_1");
  });

  test("GetCapabilities 不支援時改用 GetServices", async () => {
    const f = await start({ capabilitiesUnsupported: true });
    const caps = await new OnvifClient(f.endpoint).capabilities();
    expect(caps.services.ptz).toBe(`http://127.0.0.1:${f.port}/onvif/service`);
    expect(caps.events).toBe(true);
    expect(f.actions()).toContain("GetServices");
  });

  test("沒有 PTZ 節點資訊時改看 profile 的預設空間", async () => {
    const f = await start();
    f.faults.set("GetNodes", { code: "Receiver", subcode: "ActionNotSupported", reason: "no" });
    const caps = await new OnvifClient(f.endpoint).capabilities();
    expect(caps.ptz).toMatchObject({ continuous: true, relative: true, zoom: false, maxPresets: null });
  });
});

describe("OnvifClient 驗證", () => {
  for (const skew of [3 * 3600_000, -3 * 3600_000]) {
    test(`相機時鐘偏差 ${skew / 3600_000} 小時仍能通過 digest 驗證`, async () => {
      const f = await start({ clockSkewMs: skew });
      const client = new OnvifClient(f.endpoint);
      await client.capabilities();
      expect(Math.abs(client.clockOffsetMs - skew)).toBeLessThan(2_000);
    });
  }

  test("本機時鐘也不準時一樣補得回來", async () => {
    const f = await start({ clockSkewMs: 3 * 3600_000 });
    const client = new OnvifClient(f.endpoint, { now: () => Date.now() - 3 * 3600_000 });
    await client.capabilities();
    expect(Math.round(client.clockOffsetMs / 3600_000)).toBe(6);
  });

  test("假相機真的檢查 Created：不補償時間差的請求被拒絕", async () => {
    const f = await start({ clockSkewMs: 3 * 3600_000 });
    const err = await rejection(
      soapCall(
        { url: `http://127.0.0.1:${f.port}/onvif/service`, action: `${NS.trt}/GetProfiles`, name: "GetProfiles", body: `<GetProfiles xmlns="${NS.trt}"/>`, credentials: f.endpoint, cameraNow: Date.now() },
        { fetch, timeoutMs: 2_000 },
      ),
    );
    expect(err.kind).toBe("auth");
  });

  test("密碼錯誤回報 auth，訊息不含密碼", async () => {
    const f = await start({ password: "s3cret-PASS" });
    const client = new OnvifClient({ ...f.endpoint, password: "wrong-s3cret-PASS" });
    const err = await rejection(client.capabilities());
    expect(err.kind).toBe("auth");
    expect(err.fault?.subcode).toBe("NotAuthorized");
    expect(err.message).not.toContain("s3cret");
    expect(String(err.stack)).not.toContain("s3cret");
  });

  test("相機時鐘在連線後被調整時，驗證失敗會重新對時再試一次", async () => {
    const f = await start();
    let elapsed = 0;
    const client = new OnvifClient(f.endpoint, { now: () => Date.now() + elapsed });
    await client.capabilities();
    elapsed = 60_000;
    f.opts.clockSkewMs = 3600_000 + elapsed;
    expect(await getPresets(client)).toEqual([]);
    expect(f.actions().slice(-3)).toEqual(["GetPresets", "GetSystemDateAndTime", "GetPresets"]);
  });

  test("剛對時過就不再重試，帳密錯誤不會多打請求", async () => {
    const f = await start();
    const client = new OnvifClient(f.endpoint);
    await client.capabilities();
    f.opts.clockSkewMs = 3600_000;
    expect((await rejection(getPresets(client))).kind).toBe("auth");
    expect(f.actions().slice(-2)).toEqual(["GetNodes", "GetPresets"]);
  });

  test("帳密特殊字元會被跳脫", async () => {
    const f = await start({ username: `a<b>&"c'`, password: "<&>]]>" });
    await new OnvifClient(f.endpoint).capabilities();
  });
});

describe("OnvifClient 網路錯誤", () => {
  test("相機遲遲不回應時回報 timeout", async () => {
    const f = await start();
    f.delays.set("GetCapabilities", 1_000);
    const err = await rejection(new OnvifClient(f.endpoint, { timeoutMs: 200 }).capabilities());
    expect(err).toMatchObject({ kind: "timeout", action: "GetCapabilities" });
  });

  test("連不上時回報 unreachable", async () => {
    const f = await start();
    const port = f.port;
    await f.stop();
    fake = null;
    const err = await rejection(new OnvifClient({ host: "127.0.0.1", port, username: "u", password: "pw-xyz" }, { timeoutMs: 2_000 }).capabilities());
    expect(err.kind).toBe("unreachable");
    expect(err.message).not.toContain("pw-xyz");
  });

  test("相機斷線重開、時鐘也變了，恢復後第一個請求就成功", async () => {
    const f = await start();
    const client = new OnvifClient(f.endpoint, { timeoutMs: 2_000 });
    await client.capabilities();
    const port = f.port;
    await f.stop();
    expect((await rejection(getPresets(client))).kind).toBe("unreachable");
    const rebooted = await start({ port, clockSkewMs: 3600_000 });
    expect(await getPresets(client)).toEqual([]);
    expect(rebooted.actions()[0]).toBe("GetSystemDateAndTime");
  });

  test("非 SOAP 的 HTTP 錯誤回報 protocol", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>nope</html>", { status: 404 }) });
    try {
      const err = await rejection(new OnvifClient({ host: "127.0.0.1", port: server.port!, username: "u", password: "p" }).syncClock());
      expect(err).toMatchObject({ kind: "protocol", httpStatus: 404 });
    } finally {
      await server.stop(true);
    }
  });

  test("一般 SOAP Fault 回報 fault 並帶出 subcode", async () => {
    const f = await start();
    f.faults.set("GetProfiles", { code: "Receiver", subcode: "NoProfile", reason: "no profile & stuff" });
    const err = await rejection(new OnvifClient(f.endpoint).capabilities());
    expect(err).toMatchObject({ kind: "fault", fault: { code: "Receiver", subcode: "NoProfile", reason: "no profile & stuff" } });
    expect(isOnvifError(err, "fault")).toBe(true);
  });
});
