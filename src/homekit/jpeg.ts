/** Width and height from a JPEG's SOF marker; null when the bytes are not a readable JPEG. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + len;
  }
  return null;
}

/** Fills the requested size (center crop when the aspect differs), never stretching. */
export function scaleArgs(ffmpegBin: string, width: number, height: number): string[] {
  return [
    ffmpegBin,
    ...["-hide_banner", "-nostdin", "-loglevel", "error"],
    ...["-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0"],
    ...["-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`],
    ...["-frames:v", "1", "-q:v", "4", "-f", "mjpeg", "pipe:1"],
  ];
}

/** Scales a snapshot with a short-lived ffmpeg; it is killed if it takes longer than `timeoutMs`. */
export async function scaleJpeg(ffmpegBin: string, jpeg: Uint8Array, width: number, height: number, timeoutMs = 4_000): Promise<Uint8Array> {
  const proc = Bun.spawn(scaleArgs(ffmpegBin, width, height), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    proc.stdin.write(jpeg);
    await proc.stdin.end();
    const [out, err, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 || out.length === 0) throw new Error(err.trim().split("\n").at(-1) || `ffmpeg exited with ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
