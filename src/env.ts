export interface Env {
  dataDir: string;
  /** 明確指定的錄影根目錄；沒指定時由 defaultRecordingsDir 決定 */
  recordingsDir: string | null;
  port: number;
  rtspPort: number;
  /** MediaMTX Control API，只監聽 127.0.0.1 */
  mediamtxApiPort: number;
  /** 主程序常駐記憶體上限；超過時先收掉所有 worker 再退出 */
  mainMemoryLimitMb: number;
  mediamtxBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
  /** 在區域網路上用 mDNS 廣播自己（讓 Home Assistant 自動發現）；`DISCOVERY=false` 關閉 */
  discovery: boolean;
  /** 廣播出去的網頁埠：容器對外映射成不同埠時用 `PUBLIC_PORT` 指定，預設同 `PORT` */
  publicPort: number;
  /** 物件辨識 worker 用的 Python（要裝好 onnxruntime、numpy、Pillow） */
  detectorPython: string;
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const port = Number(source.PORT || 8765);
  return {
    dataDir: source.DATA_DIR || "/data",
    recordingsDir: source.RECORDINGS_DIR || null,
    port,
    rtspPort: Number(source.RTSP_PORT || 8554),
    mediamtxApiPort: Number(source.MEDIAMTX_API_PORT || 9997),
    mainMemoryLimitMb: Number(source.MAIN_MEMORY_LIMIT_MB || 512),
    mediamtxBin: source.MEDIAMTX_BIN || "mediamtx",
    ffmpegBin: source.FFMPEG_BIN || "ffmpeg",
    ffprobeBin: source.FFPROBE_BIN || "ffprobe",
    discovery: !/^(0|false|off|no)$/i.test(source.DISCOVERY || ""),
    publicPort: Number(source.PUBLIC_PORT || port),
    detectorPython: source.DETECTOR_PYTHON || "python3",
  };
}

/**
 * port 被佔用時給使用者看的說明。網頁在 bridge 網路下只要改主機那一側；RTSP 不行，介面顯示的 RTSP 網址
 * 用的是容器內的埠，所以主機與容器兩側要改成同一個數字。建議的 port 避開鄰近的常見服務（go2rtc 用 8555）。
 */
export function portInUseMessage(port: number, variable: "PORT" | "RTSP_PORT"): string {
  const purpose = variable === "PORT" ? "網頁" : "RTSP 轉發";
  const example = port + 10;
  const bridge =
    variable === "PORT"
      ? `只要把主機那一側的 port 改掉，容器內維持 ${port}。`
      : `把 ${variable} 和主機、容器兩側的 port 都改成同一個數字（例如 ${variable}=${example}，對應 ${example}:${example}）。`;
  return [
    `[env] ${purpose}要用的 port ${port} 已經被這台主機上的其他程式使用。`,
    `  容器用 Host 網路時：設定環境變數 ${variable} 換一個沒人用的 port（例如 ${example}）。`,
    `  容器用 bridge 網路時：${bridge}`,
  ].join("\n");
}
