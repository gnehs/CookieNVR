import { t } from "@lingui/core/macro";

/** 測試連線失敗時，錯誤要掛在哪一欄 */
export type ProbeField = "host" | "credentials" | "url" | "subUrl" | null;

export interface ProbeHelp {
  field: ProbeField;
  /** 一句說明加下一步，不含英文原文 */
  message: string;
}

/**
 * 把後端 explainFailure 的中文訊息（前面可能有「主碼流：」「子碼流：」）換成掛在欄位旁的一句話。
 * 後端訊息的最後一種情況會附上 ffmpeg 原文，這裡一律不顯示，原文留給「複製錯誤內容」。
 */
const busy = () =>
  t`The camera responded but isn't sending video, usually because its stream connections are full (a Tapo allows only about 1 to 2 per quality). Pause Frigate, Home Assistant, other NVRs, or phone apps that connect to this camera directly, then try again. After adding it, other software can use CookieNVR's stream URL instead (copy it from the camera's "Advanced" settings), so it no longer needs to connect to the camera directly.`;

export function explainProbe(error: string, type: "tapo" | "rtsp"): ProbeHelp {
  const sub = error.startsWith("子碼流：");
  const msg = error.replace(/^(主碼流|子碼流)：/, "");
  const tapo = type === "tapo";
  const at = (field: ProbeField): ProbeField => (sub ? "subUrl" : field);
  const say = (field: ProbeField, message: string): ProbeHelp => ({ field: at(field), message: sub ? t`Low-quality stream: ${message}` : message });
  const hostOrUrl: ProbeField = tapo ? "host" : "url";

  if (msg.startsWith("帳號或密碼錯誤")) {
    return say(
      "credentials",
      tapo
        ? t`Wrong username or password. Use the credentials you created under "Advanced settings → Camera account" in the Tapo app, not your TP-Link cloud account.`
        : t`Wrong username or password. Check the credentials after rtsp:// in the URL.`,
    );
  }
  if (msg.startsWith("攝影機拒絕存取")) return say("credentials", t`This account isn't allowed to view the video. Check the account's permissions in the camera's settings.`);
  if (msg.startsWith("找不到這個串流")) {
    return say(
      hostOrUrl,
      tapo ? t`The camera says it can't find a video stream. Make sure this is a Tapo camera.` : t`Stream not found. Check that the path at the end of the URL (for example /stream1) is correct.`,
    );
  }
  if (msg.startsWith("攝影機拒絕了連線") || msg.startsWith("攝影機有回應")) return say("host", busy());
  if (msg.startsWith("連線被拒絕")) {
    return say(
      hostOrUrl,
      tapo
        ? t`The camera refused the connection. Check that the IP address is correct and that you created a camera account in the Tapo app. If Frigate or other software is watching this camera, its connections may also be full.`
        : t`The camera refused the connection. Check that the IP address and port are correct and that the camera's RTSP feature is turned on.`,
    );
  }
  if (msg.startsWith("無法連到這個位址")) return say(hostOrUrl, t`Can't reach this address. Check that the camera is on and on the same network as this host.`);
  if (msg.startsWith("無法解析主機名稱")) return say(hostOrUrl, t`Can't find this hostname. Check it for typos.`);
  if (msg.startsWith("連線逾時")) return say(hostOrUrl, t`The camera isn't responding. Check that the IP address is correct and the camera is on.`);
  if (msg.startsWith("串流中沒有影像軌")) return say(hostOrUrl, t`This stream has no video. Use the URL of a video stream instead.`);
  if (msg.startsWith("找不到 ffprobe")) return { field: null, message: t`This host is missing the program used to test connections, so it can't test. Copy the error and send it to a technician.` };
  return say(
    hostOrUrl,
    tapo ? t`Can't read any video. Check that the IP address is correct and the camera is on.` : t`Can't read any video. Check that the stream URL is correct and the camera's RTSP feature is turned on.`,
  );
}

const MASK = "••••";

/** rtsp://帳號:密碼@主機 → rtsp://帳號:••••@主機；沒有密碼就原樣 */
export function maskUrlPassword(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:\s]*:)([^/@\s]+)@/i, (_, head: string) => `${head}${MASK}@`);
}

/**
 * 串流網址欄位：沒聚焦時畫面上遮住密碼，聚焦後顯示完整內容可以編輯。
 * value() 永遠是使用者真正輸入的網址，送出的值不受遮蔽影響。
 */
export function maskedField(initial: string) {
  let real = initial;
  let focused = false;
  return {
    value: () => real,
    display: () => (focused ? real : maskUrlPassword(real)),
    focus() {
      focused = true;
    },
    blur() {
      focused = false;
    },
    /** 未聚焦時畫面上可能是遮蔽值，帶著遮罩的內容不能拿來覆蓋真正的網址（例如沒先聚焦就觸發的自動填入） */
    input(v: string) {
      if (focused || !v.includes(MASK)) real = v;
    },
  };
}
