import { describe, expect, test } from "bun:test";
import { msg } from "../../../src/messages/index.ts";
import type { CameraConfig } from "../../../src/types.ts";
import { connKey, detectSummary, draftOf, editReducer, errorCard, invalidFields, planSave, probeFailure, sectionChanged, validate, type SectionEdit, type SectionKey } from "./form-model.ts";

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

const SECTIONS: SectionKey[] = ["basic", "conn", "rec", "detect", "ptz"];
const changedSections = (d: ReturnType<typeof draftOf>, start: ReturnType<typeof draftOf>) => SECTIONS.filter((k) => sectionChanged(k, d, start));

describe("sectionChanged", () => {
  test("an untouched draft changes no section", () => {
    expect(changedSections(draftOf(rtsp), draftOf(rtsp))).toEqual([]);
  });

  test("each change marks only its own section", () => {
    const saved = draftOf(rtsp);
    expect(changedSections({ ...saved, name: "後門" }, saved)).toEqual(["basic"]);
    expect(changedSections({ ...saved, transport: "udp" }, saved)).toEqual(["conn"]);
    expect(changedSections({ ...saved, recDirect: true }, saved)).toEqual(["conn"]);
    expect(changedSections({ ...saved, recAudio: false }, saved)).toEqual(["rec"]);
    expect(changedSections({ ...saved, detect: { ...saved.detect!, threshold: 15 } }, saved)).toEqual(["detect"]);
    expect(changedSections({ ...saved, ptz: { mode: "relative", speed: 0.5 } }, saved)).toEqual(["ptz"]);
  });

  test("typing the same Tapo host back is not a change", () => {
    const tapo: CameraConfig = { ...rtsp, connection: { type: "tapo", host: "10.0.0.9", username: "a", password: "b" } };
    const saved = draftOf(tapo);
    expect(connKey({ ...saved, tapoHost: " 10.0.0.9 " })).toBe(connKey(saved));
    expect(sectionChanged("conn", { ...saved, tapoHost: " 10.0.0.9 ", mainUrl: "rtsp://x/y" }, saved)).toBe(false);
  });
});

const editing = (key: SectionKey, config: CameraConfig, patch: Partial<ReturnType<typeof draftOf>> = {}): SectionEdit => {
  const opened = editReducer(null, { type: "open", key, from: draftOf(config) });
  return editReducer(opened, { type: "patch", patch })!;
};

describe("planSave", () => {
  test("saving one section keeps every other section from the current config", () => {
    const edit = editing("rec", rtsp, { recAudio: false, name: "改了但不屬於這一區" });
    const current: CameraConfig = { ...rtsp, name: "別處剛改的名字" };
    const r = planSave(edit, current, undefined);
    if (!("config" in r)) throw new Error(r.error.summary);
    expect(r.config.record).toEqual({ enabled: true, audio: false, direct: false });
    expect(r.config.name).toBe("別處剛改的名字");
    expect(r.config.connection).toEqual(rtsp.connection);
    expect(r.test).toBeNull();
  });

  test("a changed connection asks for a test first; an unchanged one does not", () => {
    const changed = planSave(editing("conn", rtsp, { transport: "udp" }), rtsp, undefined);
    if (!("config" in changed)) throw new Error(changed.error.summary);
    expect(changed.test).toEqual({ ...rtsp.connection, transport: "udp" } as CameraConfig["connection"]);
    const direct = planSave(editing("conn", rtsp, { recDirect: true }), rtsp, undefined);
    if (!("config" in direct)) throw new Error(direct.error.summary);
    expect(direct.test).toBeNull();
    expect(direct.config.record.direct).toBe(true);
  });

  test("an invalid field in the open section comes back as that section's error", () => {
    const r = planSave(editing("basic", rtsp, { name: "  " }), rtsp, undefined);
    if (!("error" in r)) throw new Error("expected an error");
    expect(errorCard(r.error)).toBe("basic");
  });

  test("detect settings stay intact when another section is saved", () => {
    const withDetect: CameraConfig = { ...rtsp, detect: { ...draftOf(rtsp).detect!, enabled: true, threshold: 15 } };
    const r = planSave(editing("basic", withDetect, { name: "後門" }), withDetect, undefined);
    if (!("config" in r)) throw new Error(r.error.summary);
    expect(r.config.detect?.threshold).toBe(15);
    expect(r.config.name).toBe("後門");
  });
});

describe("editReducer", () => {
  test("editing a flagged field clears the error; editing another field keeps it", () => {
    let s = editing("conn", rtsp);
    s = editReducer(s, { type: "fail", error: { summary: "x", field: { key: "ovPort", message: "bad", also: [] } } })!;
    expect(editReducer(s, { type: "patch", patch: { ovUser: "a" } })!.error).not.toBeNull();
    expect(editReducer(s, { type: "patch", patch: { ovPort: "81" } })!.error).toBeNull();
    expect(editReducer(s, { type: "patch", patch: { type: "tapo" } })!.error).toBeNull();
  });

  test("a failed save returns to editing with the error", () => {
    const s = editReducer(editing("conn", rtsp), { type: "submit", status: "testing" })!;
    expect(s.status).toBe("testing");
    const failed = editReducer(s, { type: "fail", error: { summary: "連不上" } })!;
    expect(failed.status).toBe("editing");
    expect(failed.error?.summary).toBe("連不上");
  });
});

describe("probeFailure", () => {
  test("wrong Tapo credentials mark the password and the account", () => {
    const e = probeFailure({ type: "tapo", host: "h", username: "u", password: "p" }, { ok: false, error: "主碼流：帳號或密碼錯誤", errorMsg: msg("probe.badCredentials"), stream: "main" });
    expect(invalidFields(e)).toEqual(["tapoPass", "tapoUser"]);
    expect(e.summary).toBe("Couldn't reach this camera, so nothing was saved");
    expect(e.copy).not.toContain("p\n");
  });

  test("ffprobe 原文只出現在複製內容裡", () => {
    const e = probeFailure({ type: "tapo", host: "h", username: "u", password: "p" }, { ok: false, error: "主碼流：攝影機有回應，但沒有送出影像，可能是同時連線數已達上限", errorMsg: msg("probe.noVideo"), stream: "main", detail: "Failed reading RTSP data: Operation timed out" });
    expect(e.copy).toContain("ffprobe output:\nFailed reading RTSP data: Operation timed out");
    expect(e.field?.message).not.toContain("Failed");
  });
});

describe("detectSummary", () => {
  test("pixel detection lists sensitivity, masks and objects", () => {
    const d = draftOf(rtsp).detect!;
    expect(detectSummary({ ...d, enabled: true, source: "both", threshold: 15, masks: [{ points: [[0, 0], [1, 0], [1, 1]] }] }, "標註人")).toBe("On · Motion + camera detection · Sensitivity: High · 1 excluded area · 標註人");
    expect(detectSummary({ ...d, enabled: false }, null)).toBe("Off");
  });
});
