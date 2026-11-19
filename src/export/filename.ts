const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

function localParts(ms: number, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `<camera name>_<YYYYMMDD>-<HHMMSS>.mp4`, the time being the start of the range on the viewer's clock. */
export function exportFileName(cameraName: string, startMs: number, tz: string): string {
  const p = localParts(startMs, tz);
  const name = cameraName.replace(UNSAFE, "_").trim().slice(0, 40) || "camera";
  return `${name}_${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}.mp4`;
}

/** Content-Disposition value: an ASCII fallback plus the real UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "").replace(/^_+/, "");
  const fallback = /^[A-Za-z0-9]/.test(ascii) ? ascii : `camera${ascii}`;
  return `attachment; filename="${fallback.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
