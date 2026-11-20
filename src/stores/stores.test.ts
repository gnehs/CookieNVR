import { describe, expect, test } from "bun:test";
import { openDb } from "../db.ts";
import { defaultSettings, type CameraConfig, type CameraId, type GroupId } from "../types.ts";
import { createCameraStore } from "./cameras.ts";
import { createSettingsStore, followRecordingsDefault } from "./settings.ts";

const config = (name: string): CameraConfig => ({
  name,
  enabled: true,
  connection: { type: "rtsp", mainUrl: "rtsp://cam/main", transport: "tcp" },
  record: { enabled: true, audio: false, direct: false },
});

describe("CameraStore", () => {
  test("id 是 8 個小寫英數字元，順序依建立先後", () => {
    const store = createCameraStore(openDb(":memory:"));
    const a = store.create(config("a"));
    const b = store.create(config("b"));
    expect(a.id).toMatch(/^[a-z0-9]{8}$/);
    expect(a.id).not.toBe(b.id);
    expect(store.list().map((c) => c.config.name)).toEqual(["a", "b"]);
    expect(b.position).toBeGreaterThan(a.position);
  });

  test("update 保留 position，remove 後不在清單", () => {
    const store = createCameraStore(openDb(":memory:"));
    const a = store.create(config("a"));
    store.create(config("b"));
    const updated = store.update(a.id, config("renamed"));
    expect(updated.position).toBe(a.position);
    expect(store.get(a.id)?.config.name).toBe("renamed");
    store.remove(a.id);
    expect(store.get(a.id)).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  test("新增、修改、刪除都通知訂閱者最新清單，取消訂閱後不再通知", () => {
    const store = createCameraStore(openDb(":memory:"));
    const seen: string[][] = [];
    const off = store.subscribe((cams) => seen.push(cams.map((c) => c.config.name)));
    const a = store.create(config("a"));
    store.update(a.id, config("a2"));
    store.remove(a.id);
    expect(seen).toEqual([["a"], ["a2"], []]);
    off();
    store.create(config("b"));
    expect(seen).toHaveLength(3);
  });

  test("訂閱者丟例外不影響其他訂閱者與寫入", () => {
    const store = createCameraStore(openDb(":memory:"));
    const orig = console.error;
    console.error = () => {};
    let got = 0;
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(() => got++);
    store.create(config("a"));
    console.error = orig;
    expect(got).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  test("更新不存在的攝影機會丟錯", () => {
    const store = createCameraStore(openDb(":memory:"));
    expect(() => store.update("nope0000" as never, config("x"))).toThrow();
  });
});

describe("CameraStore 分區與排列", () => {
  const setup = () => {
    const store = createCameraStore(openDb(":memory:"));
    const [a, b, c] = ["a", "b", "c"].map((n) => store.create(config(n)));
    return { store, a: a!, b: b!, c: c! };
  };
  const names = (store: ReturnType<typeof createCameraStore>) => store.list().map((x) => `${x.config.name}:${x.groupId ? store.groups().find((g) => g.id === x.groupId)?.name : "-"}`);

  test("新增的分區排在最後，改名後名稱跟著變", () => {
    const { store } = setup();
    const out = store.createGroup("一樓");
    store.createGroup("戶外");
    store.renameGroup(out.id, "樓下");
    expect(store.groups().map((g) => g.name)).toEqual(["樓下", "戶外"]);
  });

  test("arrange 依送來的順序排分區與攝影機，沒有分區的排在最前面", () => {
    const { store, a, b, c } = setup();
    const g1 = store.createGroup("一樓");
    const g2 = store.createGroup("戶外");
    store.arrange({ groups: [g2.id, g1.id], cameras: [{ id: c.id, groupId: g1.id }, { id: a.id, groupId: g2.id }, { id: b.id, groupId: null }] });
    expect(store.groups().map((g) => g.name)).toEqual(["戶外", "一樓"]);
    expect(names(store)).toEqual(["b:-", "a:戶外", "c:一樓"]);
  });

  test("重送同一份排列不會再通知訂閱者", () => {
    const { store, a, b, c } = setup();
    const g = store.createGroup("一樓");
    const arrangement = { groups: [g.id], cameras: [{ id: b.id, groupId: g.id }, { id: a.id, groupId: null }, { id: c.id, groupId: null }] };
    store.arrange(arrangement);
    let calls = 0;
    store.subscribe(() => calls++);
    store.subscribeGroups(() => calls++);
    store.arrange(arrangement);
    expect(calls).toBe(0);
  });

  test("排列跟現況對不上時不報錯：不存在的略過，漏掉的接在後面", () => {
    const { store, a, b, c } = setup();
    const g = store.createGroup("一樓");
    store.arrange({
      groups: ["gone0000" as GroupId],
      cameras: [{ id: "gone0000" as CameraId, groupId: null }, { id: c.id, groupId: "gone0000" as GroupId }, { id: a.id, groupId: g.id }],
    });
    expect(store.groups().map((x) => x.id)).toEqual([g.id]);
    expect(names(store)).toEqual(["c:-", "b:-", "a:一樓"]);
  });

  test("刪掉分區後裡面的攝影機變成沒有分區，其他分區不受影響", () => {
    const { store, a, b } = setup();
    const g1 = store.createGroup("一樓");
    const g2 = store.createGroup("戶外");
    store.arrange({ groups: [g1.id, g2.id], cameras: [{ id: a.id, groupId: g1.id }, { id: b.id, groupId: g2.id }] });
    store.removeGroup(g1.id);
    expect(store.groups().map((g) => g.name)).toEqual(["戶外"]);
    expect(store.get(a.id)?.groupId).toBeNull();
    expect(store.get(b.id)?.groupId).toBe(g2.id);
  });
});

describe("SettingsStore", () => {
  test("沒有的 key 用預設值，更新後保留其他預設", () => {
    const store = createSettingsStore(openDb(":memory:"), "/data");
    expect(store.get()).toEqual(defaultSettings("/data"));
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.siteName));
    const next = store.update({ siteName: "Home", rtsp: { externalEnabled: false } });
    expect(next.siteName).toBe("Home");
    expect(next.rtsp.externalEnabled).toBe(false);
    expect(next.storagePath).toBe("/data/recordings");
    expect(store.get()).toEqual(next);
    expect(seen).toEqual(["Home"]);
  });

  test("資料持久化在資料庫", () => {
    const db = openDb(":memory:");
    createSettingsStore(db, "/data").update({ siteName: "X" });
    expect(createSettingsStore(db, "/data").get().siteName).toBe("X");
  });

  test("沒指定過錄影位置就跟著預設走：之後掛了 /recordings 自動改用；選回預設位置等於恢復自動", () => {
    const db = openDb(":memory:");
    createSettingsStore(db, "/data").update({ siteName: "X" });
    expect(createSettingsStore(db, "/data", "/recordings").get().storagePath).toBe("/recordings");
    const store = createSettingsStore(db, "/data", "/recordings");
    store.update({ storagePath: "/recordings" });
    expect(db.query("SELECT 1 FROM settings WHERE key = 'storagePath'").get()).toBeNull();
    store.update({ storagePath: "/mnt/nas" });
    expect(createSettingsStore(db, "/data", "/elsewhere").get().storagePath).toBe("/mnt/nas");
  });

  test("存下來的錄影位置剛好是 <dataDir>/recordings、而現在的預設在別處：視為自動決定，改用新的預設", () => {
    const db = openDb(":memory:");
    createSettingsStore(db, "/data").update({ retention: { continuousDays: 3, eventDays: 30, minFreeBytes: 1 } });
    db.query("INSERT INTO settings (key, value) VALUES ('storagePath', ?)").run(JSON.stringify("/data/recordings"));
    expect(followRecordingsDefault(db, "/data", "/data/recordings")).toBeNull();
    expect(followRecordingsDefault(db, "/data", "/recordings")).toBe("/data/recordings");
    expect(createSettingsStore(db, "/data", "/recordings").get()).toMatchObject({ storagePath: "/recordings", retention: { continuousDays: 3 } });
    expect(followRecordingsDefault(db, "/data", "/recordings")).toBeNull();
  });

  test("使用者自己選的錄影位置不會被換掉", () => {
    const db = openDb(":memory:");
    createSettingsStore(db, "/data").update({ storagePath: "/mnt/nas" });
    expect(followRecordingsDefault(db, "/data", "/recordings")).toBeNull();
    expect(createSettingsStore(db, "/data", "/recordings").get().storagePath).toBe("/mnt/nas");
  });

  test("舊資料的 devices 只有 objects：decode 補預設值，objects 保留原值", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO settings (key, value) VALUES ('devices', ?)").run(JSON.stringify({ objects: "intel:GPU.0" }));
    expect(createSettingsStore(db, "/data").get().devices).toEqual({ objects: "intel:GPU.0", decode: "auto" });
  });
});
