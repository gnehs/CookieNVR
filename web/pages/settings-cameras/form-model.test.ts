import { describe, expect, test } from "bun:test";
import type { CameraConfig } from "../../../src/types.ts";
import { connKey, detectSummary, dirtyCards, draftOf, errorCard, invalidFields, probeFailure, validate } from "./form-model.ts";

const rtsp: CameraConfig = {
  name: "前門",
  enabled: true,
  connection: { type: "rtsp", mainUrl: "rtsp://u:p@10.0.0.5/s1", transport: "tcp", onvif: { host: "10.0.0.5", port: 80, username: "u", password: "p" } },
  record: { enabled: true, audio: true, direct: false },
};

describe("draftOf", () => {
  test("a new camera starts as Tapo with recording on and no detect settings", () => {
    const d = draftOf(null);
    expect(d.type).toBe("tapo");
    expect(d.recEnabled).toBe(true);
    expect(d.detect).toBeNull();
    expect(d.ptz).toBeUndefined();
  });

  test("an RTSP camera round-trips through validate unchanged", () => {
    const d = draftOf(rtsp);
    const r = validate(d, rtsp, undefined);
    if (!("config" in r)) throw new Error(r.error.summary);
    expect(r.config.connection).toEqual(rtsp.connection);
    expect(r.config.name).toBe("前門");
  });
});

describe("validate", () => {
  test("a missing name points at the name field in the basic card", () => {
    const r = validate(draftOf(null), null, undefined);
    if (!("error" in r)) throw new Error("expected an error");
    expect(r.error.field?.key).toBe("name");
    expect(errorCard(r.error)).toBe("basic");
  });

  test("a bad ONVIF port lands in the connection card", () => {
    const d = { ...draftOf(rtsp), ovPort: "70000" };
    const r = validate(d, rtsp, undefined);
    if (!("error" in r)) throw new Error("expected an error");
    expect(r.error.field?.key).toBe("ovPort");
    expect(errorCard(r.error)).toBe("conn");
  });
});

describe("dirtyCards", () => {
  test("an untouched form has no dirty card", () => {
    expect(dirtyCards(draftOf(rtsp), draftOf(rtsp)).size).toBe(0);
  });

  test("each change marks only its own card", () => {
    const saved = draftOf(rtsp);
    expect([...dirtyCards({ ...saved, name: "後門" }, saved)]).toEqual(["basic"]);
    expect([...dirtyCards({ ...saved, transport: "udp" }, saved)]).toEqual(["conn"]);
    expect([...dirtyCards({ ...saved, recAudio: false }, saved)]).toEqual(["rec"]);
    expect([...dirtyCards({ ...saved, detect: { ...saved.detect!, threshold: 15 } }, saved)]).toEqual(["detect"]);
    expect([...dirtyCards({ ...saved, ptz: { mode: "relative", speed: 0.5 } }, saved)]).toEqual(["ptz"]);
  });

  test("typing the same Tapo host back is not a change", () => {
    const tapo: CameraConfig = { ...rtsp, connection: { type: "tapo", host: "10.0.0.9", username: "a", password: "b" } };
    const saved = draftOf(tapo);
    expect(connKey({ ...saved, tapoHost: " 10.0.0.9 " })).toBe(connKey(saved));
  });
});

describe("probeFailure", () => {
  test("wrong Tapo credentials mark the password and the account", () => {
    const e = probeFailure({ type: "tapo", host: "h", username: "u", password: "p" }, "帳號或密碼錯誤（401）");
    expect(invalidFields(e)).toEqual(["tapoPass", "tapoUser"]);
    expect(e.summary).toBe("連不上這台攝影機，所以還沒儲存");
    expect(e.copy).not.toContain("p\n");
  });
});

describe("detectSummary", () => {
  test("pixel detection lists sensitivity, masks and objects", () => {
    const d = draftOf(rtsp).detect!;
    expect(detectSummary({ ...d, enabled: true, source: "both", threshold: 15, masks: [{ points: [[0, 0], [1, 0], [1, 1]] }] }, "標註人")).toBe("已開啟 · 畫面變化＋相機偵測 · 靈敏度高 · 1 個排除區域 · 標註人");
    expect(detectSummary({ ...d, enabled: false }, null)).toBe("未開啟");
  });
});
