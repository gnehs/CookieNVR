import { describe, expect, test } from "bun:test";
import { explainFailure } from "../src/camera/probe.ts";
import { explainProbe, maskedField, maskUrlPassword } from "./camera-form-logic.ts";

describe("explainProbe", () => {
  const cases: [stderr: string, timedOut: boolean, tapo: "host" | "credentials" | "url", rtsp: "host" | "credentials" | "url"][] = [
    ["401 Unauthorized", false, "credentials", "credentials"],
    ["403 Forbidden", false, "credentials", "credentials"],
    ["404 Not Found", false, "host", "url"],
    ["453 Not Enough Bandwidth", false, "host", "host"],
    ["Connection refused", false, "host", "url"],
    ["No route to host", false, "host", "url"],
    ["Failed to resolve hostname cam.local", false, "host", "url"],
    ["", true, "host", "url"],
    ["[rtsp @ 0x1] method DESCRIBE failed: Weird Thing", false, "host", "url"],
  ];

  for (const [stderr, timedOut, tapoField, rtspField] of cases) {
    test(`後端「${explainFailure(stderr, timedOut, false)}」掛在對的欄位，而且沒有英文原文`, () => {
      for (const type of ["tapo", "rtsp"] as const) {
        const help = explainProbe(`主碼流：${explainFailure(stderr, timedOut, type === "tapo")}`, type);
        expect(help.field).toBe(type === "tapo" ? tapoField : rtspField);
        expect(help.message.replace(/Tapo|App|RTSP|TP-Link|rtsp|IP|stream1/g, "")).not.toMatch(/[A-Za-z]{2,}/);
        expect(help.message).not.toContain("主碼流");
      }
    });
  }

  test("低畫質串流的失敗一律掛在低畫質網址欄", () => {
    const help = explainProbe(`子碼流：${explainFailure("404 Not Found", false, false)}`, "rtsp");
    expect(help).toEqual({ field: "subUrl", message: "低畫質串流：找不到這個串流，請確認網址最後的路徑（例如 /stream1）是否正確。" });
  });

  test("主機缺少 ffprobe 時沒有對應欄位", () => {
    expect(explainProbe("主碼流：找不到 ffprobe（ffprobe），請確認已安裝", "tapo").field).toBeNull();
  });
});

describe("maskUrlPassword", () => {
  test("遮住帳號後面的密碼", () => {
    expect(maskUrlPassword("rtsp://admin:s3cr:et@192.168.1.60:554/stream1")).toBe("rtsp://admin:••••@192.168.1.60:554/stream1");
  });

  test("沒有密碼或沒有帳密時原樣", () => {
    expect(maskUrlPassword("rtsp://192.168.1.60:554/stream1")).toBe("rtsp://192.168.1.60:554/stream1");
    expect(maskUrlPassword("rtsp://admin@192.168.1.60/s")).toBe("rtsp://admin@192.168.1.60/s");
    expect(maskUrlPassword("")).toBe("");
  });
});

describe("maskedField", () => {
  test("未聚焦時畫面遮住密碼，送出的值仍是完整網址", () => {
    const f = maskedField("rtsp://u:pw@h/s1");
    expect(f.display()).toBe("rtsp://u:••••@h/s1");
    expect(f.value()).toBe("rtsp://u:pw@h/s1");
  });

  test("聚焦後顯示完整內容，編輯後失焦再遮住", () => {
    const f = maskedField("rtsp://u:pw@h/s1");
    f.focus();
    expect(f.display()).toBe("rtsp://u:pw@h/s1");
    f.input("rtsp://u:newpw@h/s2");
    f.blur();
    expect(f.display()).toBe("rtsp://u:••••@h/s2");
    expect(f.value()).toBe("rtsp://u:newpw@h/s2");
  });

  test("未聚焦時畫面上的遮蔽值不會覆蓋真正的網址", () => {
    const f = maskedField("rtsp://u:pw@h/s1");
    f.input(f.display());
    expect(f.value()).toBe("rtsp://u:pw@h/s1");
  });

  test("沒聚焦就填入的完整網址照收（例如自動填入）", () => {
    const f = maskedField("");
    f.input("rtsp://u:pw@h/s1");
    expect(f.value()).toBe("rtsp://u:pw@h/s1");
    expect(f.display()).toBe("rtsp://u:••••@h/s1");
  });
});
