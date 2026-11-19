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
  const port = Number(source.PORT ?? 8765);
  return {
    dataDir: source.DATA_DIR ?? "/data",
    recordingsDir: source.RECORDINGS_DIR || null,
    port,
    rtspPort: Number(source.RTSP_PORT ?? 8554),
    mediamtxApiPort: Number(source.MEDIAMTX_API_PORT ?? 9997),
    mainMemoryLimitMb: Number(source.MAIN_MEMORY_LIMIT_MB ?? 512),
    mediamtxBin: source.MEDIAMTX_BIN ?? "mediamtx",
    ffmpegBin: source.FFMPEG_BIN ?? "ffmpeg",
    ffprobeBin: source.FFPROBE_BIN ?? "ffprobe",
    discovery: !/^(0|false|off|no)$/i.test(source.DISCOVERY ?? ""),
    publicPort: Number(source.PUBLIC_PORT ?? port),
    detectorPython: source.DETECTOR_PYTHON ?? "python3",
  };
}
