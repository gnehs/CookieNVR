import { plural, t } from "@lingui/core/macro";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(ms)}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const d = plural(days, { one: "# day", other: "# days" });
  const h = plural(hours, { one: "# hour", other: "# hours" });
  if (days > 0) return `${d} ${h}`;
  if (hours > 0) return `${h} ${t`${minutes} min`}`;
  if (minutes > 0) return `${t`${minutes} min`} ${t`${seconds} sec`}`;
  return t`${seconds} sec`;
}

export function formatAgo(ms: number | null): string {
  if (ms == null) return t`Never`;
  const diff = Date.now() - ms;
  if (diff < 60_000) return t`Just now`;
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    return plural(minutes, { one: "# minute ago", other: "# minutes ago" });
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return plural(hours, { one: "# hour ago", other: "# hours ago" });
  }
  return formatDateTime(ms).slice(0, 10);
}

/** 名稱清單的分隔：英文「, 」，中日文「、」 */
export function joinList(items: readonly string[]): string {
  return items.join(t({ message: ", ", context: "list separator" }));
}

/** 句子片段的分隔：英文「, 」，中文「，」，日文「、」 */
export function joinClauses(items: readonly string[]): string {
  return items.join(t({ message: ", ", context: "clause separator" }));
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function browserTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
