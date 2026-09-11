export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Zero-padded so the lexicographic sort in groupByDay matches chronological
// order — unpadded keys like "2026-8-9" > "2026-8-10" as strings, which pinned
// the Sep 9 group above all later days the moment the month hit double digits.
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function dayLabel(iso: string): string {
  // Fixed locale, not the browser's — every other string in this UI is
  // English, so a day header shouldn't switch language on its own.
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function isWithinHours(iso: string, hours: number): boolean {
  return Date.now() - new Date(iso).getTime() < hours * 3600 * 1000;
}

/** Accepts only http/https URLs with a non-empty hostname. */
export function isHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
