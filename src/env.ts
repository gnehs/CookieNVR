export interface Env {
  dataDir: string;
  port: number;
  rtspPort: number;
  /** MediaMTX Control API，只監聽 127.0.0.1 */
  mediamtxApiPort: number;
  mediamtxBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  return {
    dataDir: source.DATA_DIR ?? "/data",
    port: Number(source.PORT ?? 8765),
    rtspPort: Number(source.RTSP_PORT ?? 8554),
    mediamtxApiPort: Number(source.MEDIAMTX_API_PORT ?? 9997),
    mediamtxBin: source.MEDIAMTX_BIN ?? "mediamtx",
    ffmpegBin: source.FFMPEG_BIN ?? "ffmpeg",
    ffprobeBin: source.FFPROBE_BIN ?? "ffprobe",
  };
}
