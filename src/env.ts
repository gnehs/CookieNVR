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
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  return {
    dataDir: source.DATA_DIR ?? "/data",
    recordingsDir: source.RECORDINGS_DIR || null,
    port: Number(source.PORT ?? 8765),
    rtspPort: Number(source.RTSP_PORT ?? 8554),
    mediamtxApiPort: Number(source.MEDIAMTX_API_PORT ?? 9997),
    mainMemoryLimitMb: Number(source.MAIN_MEMORY_LIMIT_MB ?? 512),
    mediamtxBin: source.MEDIAMTX_BIN ?? "mediamtx",
    ffmpegBin: source.FFMPEG_BIN ?? "ffmpeg",
    ffprobeBin: source.FFPROBE_BIN ?? "ffprobe",
  };
}
