import type { ListCheckpoint, SourceConfig, SourceType } from "./types.js";

// ─── Silent-staleness detection ─────────────────────────────────────────
// A cycle that fetches successfully but yields zero new items is recorded as
// `last_fetch_status = "ok"` — indistinguishable from a healthy source that
// simply has nothing new. That's how a broken scrape hides: green status dot,
// recent "Updated 2m ago", and an empty feed for days (exactly the failure
// mode behind "list feeds returning zero tweets after X dropped user.legacy").
//
// So checkpoints also track the last *productive* cycle (`lastItemAt`) and
// when we first started watching a source (`watchingSince`). If neither has
// advanced within the threshold, the source is stale and the UI raises it as
// an error snack instead of leaving it silently green.

export const DEFAULT_STALENESS_THRESHOLD_HOURS = 12;

// Types where a long dry spell is a *symptom*. An X list or a news API that
// returns nothing for half a day is almost certainly broken upstream, not
// quiet. `rss_feed` and `website_diff` are the opposite: a blog that doesn't
// post and a pricing page that doesn't change are the normal steady state, so
// alerting on them by default would be pure noise. Those can still opt in per
// source via SourceConfig.stalenessThresholdHours.
const ALERTING_TYPES: ReadonlySet<SourceType> = new Set<SourceType>(["twitter_list", "media_list"]);

// Injected once by startTerminal (config-injection singleton, same pattern as
// initDb/configureSummarizer/...). The core reads nothing from the env itself.
let defaultThresholdHours = DEFAULT_STALENESS_THRESHOLD_HOURS;

export function configureStaleness(thresholdHours?: number): void {
  if (thresholdHours !== undefined) defaultThresholdHours = thresholdHours;
}

/**
 * The dry-spell threshold for one source, or null when staleness alerting is
 * off for it. Per-source `stalenessThresholdHours` always wins (use 0 to
 * silence a noisy source, or a positive value to opt an rss_feed/website_diff
 * in); otherwise alerting types get the deployment-wide default and the rest
 * get nothing. Resolved once per source at build time and carried on `Source`,
 * so the scheduler and the API never re-derive policy.
 */
export function resolveStalenessThresholdHours(config: SourceConfig): number | null {
  const override = config.stalenessThresholdHours;
  if (override !== undefined) return override > 0 ? override : null;
  if (!ALERTING_TYPES.has(config.type)) return null;
  return defaultThresholdHours > 0 ? defaultThresholdHours : null;
}

export interface StalenessState {
  stale: boolean;
  /** Timestamp staleness is measured from: the last productive cycle, else when watching began. */
  sinceIso: string;
  elapsedMs: number;
  thresholdHours: number;
  /** False when the source has never produced a single item — a config/selector problem, not a regression. */
  everProduced: boolean;
}

/**
 * Evaluates a source's dry spell. Returns null when staleness doesn't apply:
 * alerting off, never fetched, or the last cycle actually failed — a failing
 * source already surfaces its own error, and stacking a second "nothing new"
 * alert on top of it would just double-report the same breakage. A `running`
 * cycle is deliberately NOT excluded: suppressing while a refresh is in
 * flight would make the alert flicker on every scheduled cycle.
 *
 * Mirrored client-side in frontend/src/staleness.ts (this repo hand-mirrors
 * wire-facing logic rather than sharing a package) so the UI can re-evaluate
 * on its own clock tick as a source crosses the threshold between events.
 */
export function evaluateStaleness(
  checkpoint: ListCheckpoint | undefined,
  thresholdHours: number | null,
  now: number = Date.now()
): StalenessState | null {
  if (!thresholdHours || thresholdHours <= 0 || !checkpoint) return null;
  if (checkpoint.lastFetchStatus === "error" || checkpoint.lastFetchStatus === "auth_expired") return null;

  const sinceIso = checkpoint.lastItemAt ?? checkpoint.watchingSince;
  if (!sinceIso) return null;

  const elapsedMs = now - Date.parse(sinceIso);
  if (!Number.isFinite(elapsedMs)) return null;

  return {
    stale: elapsedMs > thresholdHours * 60 * 60 * 1000,
    sinceIso,
    elapsedMs,
    thresholdHours,
    everProduced: Boolean(checkpoint.lastItemAt),
  };
}
