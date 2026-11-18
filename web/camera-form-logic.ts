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
export function explainProbe(error: string, type: "tapo" | "rtsp"): ProbeHelp {
  const sub = error.startsWith("子碼流：");
  const msg = error.replace(/^(主碼流|子碼流)：/, "");
  const tapo = type === "tapo";
  const at = (field: ProbeField): ProbeField => (sub ? "subUrl" : field);
  const say = (field: ProbeField, message: string): ProbeHelp => ({ field: at(field), message: sub ? `低畫質串流：${message}` : message });

  if (msg.startsWith("帳號或密碼錯誤")) {
    return say("credentials", tapo ? "帳號或密碼不對。請用 Tapo App「進階設定 → 相機帳戶」建立的帳密，不是 TP-Link 雲端帳號。" : "帳號或密碼不對，請檢查網址中 rtsp:// 後面的帳號與密碼。");
  }
  if (msg.startsWith("攝影機拒絕存取")) return say("credentials", "這組帳號沒有觀看畫面的權限，請到相機的設定確認帳號權限。");
  if (msg.startsWith("找不到這個串流")) return say(tapo ? "host" : "url", tapo ? "相機說找不到影像串流，請確認這是一台 Tapo 攝影機。" : "找不到這個串流，請確認網址最後的路徑（例如 /stream1）是否正確。");
  if (msg.startsWith("攝影機拒絕了連線")) return say("host", "相機的連線數已滿，請關掉其他正在看畫面的 App 後再試一次。");
  if (msg.startsWith("連線被拒絕")) return say(tapo ? "host" : "url", tapo ? "相機拒絕連線，請確認 IP 位址正確，且在 Tapo App 建立了相機帳戶。" : "相機拒絕連線，請確認 IP 位址與連接埠正確，且相機的 RTSP 功能已開啟。");
  if (msg.startsWith("無法連到這個位址")) return say(tapo ? "host" : "url", "連不到這個位址，請確認相機已開機，且和這台主機在同一個網路。");
  if (msg.startsWith("無法解析主機名稱")) return say(tapo ? "host" : "url", "找不到這個主機名稱，請檢查是否打錯字。");
  if (msg.startsWith("連線逾時")) return say(tapo ? "host" : "url", "相機沒有回應，請確認 IP 位址正確、相機已開機。");
  if (msg.startsWith("串流中沒有影像軌")) return say(tapo ? "host" : "url", "這個串流沒有影像，請改用影像串流的網址。");
  if (msg.startsWith("找不到 ffprobe")) return { field: null, message: "這台主機少了測試用的程式，無法測試連線。請複製錯誤內容給技術人員。" };
  return say(tapo ? "host" : "url", tapo ? "讀不到影像，請確認 IP 位址正確、相機已開機。" : "讀不到影像，請確認串流網址正確、相機的 RTSP 功能已開啟。");
}

/** rtsp://帳號:密碼@主機 → rtsp://帳號:••••@主機；沒有密碼就原樣 */
export function maskUrlPassword(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:\s]*:)([^/@\s]+)@/i, (_, head: string) => `${head}••••@`);
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
    /** 只在聚焦時收得到；未聚焦時畫面上的是遮蔽值，不能拿來覆蓋 */
    input(v: string) {
      if (focused) real = v;
    },
    set(v: string) {
      real = v;
    },
  };
}
