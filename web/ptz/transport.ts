import { api } from "../api.ts";
import type { Transport, Vec } from "./driver.ts";

/** 把方向向量送到後端。hold 與 pulse 要求持續移動，step 要求相對移動；速度每次讀目前的設定 */
export function apiTransport(cameraId: string, speed: () => number): Transport {
  return {
    move: (vec: Vec, kind) => api.ptzMove(cameraId, { ...vec, speed: speed(), mode: kind === "step" ? "relative" : "continuous" }),
    stop: () => api.ptzStop(cameraId),
  };
}

/** 頁面被關掉或重新整理時 fetch 會被取消；keepalive 讓這一個 stop 在頁面消失後還是送得出去 */
export function stopOnUnload(cameraId: string): void {
  try {
    void fetch(`/api/cameras/${encodeURIComponent(cameraId)}/ptz`, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }).catch(() => {});
  } catch {}
}
