import { expect, test } from "bun:test";
import { readEnv } from "./env.ts";
import { defaultRecordingsDir, isSeparateMount } from "./recordings-dir.ts";

test("明確指定的 RECORDINGS_DIR 優先", () => {
  const env = readEnv({ DATA_DIR: "/data", RECORDINGS_DIR: "/mnt/hdd" });
  expect(defaultRecordingsDir(env, () => true)).toBe("/mnt/hdd");
});

test("有掛 /recordings 就把錄影放那裡，資料庫留在 /data", () => {
  expect(defaultRecordingsDir(readEnv({ DATA_DIR: "/data" }), (p) => p === "/recordings")).toBe("/recordings");
});

test("只掛 /data 時錄影放在資料目錄底下", () => {
  expect(defaultRecordingsDir(readEnv({ DATA_DIR: "/data" }), () => false)).toBe("/data/recordings");
  expect(defaultRecordingsDir(readEnv({ DATA_DIR: "/data", RECORDINGS_DIR: "" }), () => false)).toBe("/data/recordings");
});

test("同一個檔案系統上的目錄不算另外掛載，不存在的路徑也不算", () => {
  const stat = (p: string) => {
    if (p === "/missing") throw new Error("ENOENT");
    return { dev: p === "/recordings" ? 42 : 1 };
  };
  expect(isSeparateMount("/recordings", stat)).toBe(true);
  expect(isSeparateMount("/plain-dir", stat)).toBe(false);
  expect(isSeparateMount("/missing", stat)).toBe(false);
});
