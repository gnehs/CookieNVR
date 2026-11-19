import { expect, test } from "bun:test";
import { portInUseMessage, readEnv, recordPermissionMessage } from "./env.ts";

test("空字串的環境變數視為沒設（Unraid 會把沒填的欄位傳成空字串）", () => {
  const env = readEnv({ PORT: "", RTSP_PORT: "", PUBLIC_PORT: "" });
  expect([env.port, env.rtspPort, env.publicPort]).toEqual([8765, 8554, 8765]);
});

test("port 被佔用的說明點名要改的環境變數；RTSP 在 bridge 網路下兩側要一起改", () => {
  const web = portInUseMessage(8765, "PORT");
  expect(web).toContain("環境變數 PORT");
  expect(web).toContain("容器內維持 8765");
  const rtsp = portInUseMessage(8554, "RTSP_PORT");
  expect(rtsp).toContain("環境變數 RTSP_PORT");
  expect(rtsp).toContain("兩側");
  expect(rtsp).not.toContain("8555");
});

test("錄影權限不足的說明點出位置、原因與 PUID:PGID 的修法", () => {
  const msg = recordPermissionMessage("record:abc", "/recordings");
  expect(msg).toContain("/recordings");
  expect(msg).toContain("PUID");
  expect(msg).toContain("chown");
});
