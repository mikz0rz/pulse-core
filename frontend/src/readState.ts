// Per-browser "have I read this story?" state, persisted in localStorage.
// This is a single-user app, so read state is intentionally client-side only —
// no server round-trip. Keyed by feed_items.id, which is globally unique
// (INTEGER PRIMARY KEY AUTOINCREMENT), so one flat set covers every list.

const KEY = "pulse.readItems.v1";

export function loadReadIds(): Set<number> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set<number>(raw ? (JSON.parse(raw) as number[]) : []);
  } catch {
    return new Set<number>();
  }
}

export function saveReadIds(ids: Set<number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Storage disabled/full — read state is best-effort; never break the feed.
  }
}
