import type { ListSummary } from "./api";

// Client mirror of the backend's src/staleness.ts (this repo hand-mirrors
// wire-facing logic instead of sharing a types package — keep the two in sync).
// The server sends the raw inputs (threshold + the checkpoint's lastItemAt /
// watchingSince) and the verdict is computed here, exactly like the refresh
// backoff, so a source crossing its threshold shows up on the UI's own minute
// tick rather than waiting for the next server event.

export interface StaleSource {
  list: ListSummary;
  /** Timestamp staleness is measured from: the last productive cycle, else when watching began. */
  sinceIso: string;
  elapsedMs: number;
  thresholdHours: number;
  /** False when the source has never produced a single item — a config problem, not a regression. */
  everProduced: boolean;
}

/**
 * A source whose refreshes keep succeeding while producing nothing — the
 * silent failure the status dot can't show, since "ok, 0 new items" looks
 * identical to a healthy quiet source. Returns null when staleness doesn't
 * apply: alerting off for this type, never fetched, still inside the window,
 * or the last cycle actually errored (that already surfaces on its own, and
 * stacking a second alert on it would double-report one breakage).
 */
export function evaluateStale(list: ListSummary, now: number = Date.now()): StaleSource | null {
  const thresholdHours = list.stalenessThresholdHours;
  if (!thresholdHours || thresholdHours <= 0) return null;

  const cp = list.checkpoint;
  if (!cp) return null;
  if (cp.lastFetchStatus === "error" || cp.lastFetchStatus === "auth_expired") return null;

  const sinceIso = cp.lastItemAt ?? cp.watchingSince;
  if (!sinceIso) return null;

  const elapsedMs = now - Date.parse(sinceIso);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= thresholdHours * 60 * 60 * 1000) return null;

  return { list, sinceIso, elapsedMs, thresholdHours, everProduced: Boolean(cp.lastItemAt) };
}

export function findStaleSources(lists: ListSummary[]): StaleSource[] {
  const now = Date.now();
  return lists
    .map((l) => evaluateStale(l, now))
    .filter((s): s is StaleSource => s !== null)
    .sort((a, b) => b.elapsedMs - a.elapsedMs);
}

/** Coarse duration for alert copy — "14h", "3d". Deliberately not relativeTime's "ago" phrasing. */
export function formatDrySpell(elapsedMs: number): string {
  const hours = Math.floor(elapsedMs / (60 * 60 * 1000));
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
