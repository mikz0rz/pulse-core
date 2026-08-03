import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type { TwitterClient } from "./twitter-client.js";
import { browserMutex } from "./browser-mutex.js";
import { buildTweetDump, generateFeedItems, generateDigest, generateSections } from "./summarizer.js";
import {
  filterNewTweets,
  insertRawTweets,
  insertFeedItems,
  markFetchRunning,
  markFetchDone,
  getRecentFeedItemsByTimestamp,
  getTopCategories,
  normalizeCategory,
  upsertDigest,
  upsertSection,
  getCheckpoint,
  type ResolvedFeedItem,
} from "./db.js";
import { evaluateStaleness, resolveStalenessThresholdHours } from "./staleness.js";
import type { TwitterListSourceConfig, Source, Tweet, ExtraSection, ListFetchStatus } from "./types.js";
import type { FeatureFlags } from "./terminal-config.js";

export const schedulerEvents = new EventEmitter();

function sanitizeErrorForClient(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  // LLM and Twitter responses can contain sensitive snippets; keep the full
  // message in server logs, but send a generic label to the UI.
  if (/OpenAI API error|Gemini API error|Twitter API error|LLM did not return valid/i.test(message)) {
    return "External service returned an error";
  }
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return "Network error while fetching source";
  }
  // Everything else: truncate to a reasonable length and strip control chars.
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}

/**
 * Pushes a list's state change to any connected client via the `list-updated`
 * SSE event (relayed in terminal.ts). Emitted on EVERY meaningful checkpoint
 * transition — cycle start ("running"), completion ("ok", with or without new
 * items), and failure ("error"/"auth_expired") — so the UI's tab status dots,
 * status bar, and "Refresh now" enablement track live state without a manual
 * reload. `count` is the number of newly-inserted items (0 when none); the
 * frontend only reloads the open feed's stories when count > 0.
 */
function emitListUpdate(listId: string, status: ListFetchStatus, count = 0): void {
  schedulerEvents.emit("list-updated", { listId, status, count });
}

const AUTH_FAILURE_THRESHOLD = 3;
const consecutiveFailures = new Map<string, number>();
const DIGEST_WINDOW_HOURS = 24;

// A source is never left staler than this: the background loop runs at least
// this often regardless of a source's configured (possibly larger) interval.
export const MAX_REFRESH_INTERVAL_MINUTES = 24 * 60;

// The floor between *user/on-open-triggered* refreshes of the same source, so
// opening the app or mashing "Refresh now" can't hammer a source (or the
// scraped account). The background scheduler is not subject to this.
export const MIN_MANUAL_REFRESH_MS = 15 * 60 * 1000;

export interface RefreshEligibility {
  allowed: boolean;
  reason?: "running" | "recent";
  retryAfterMs?: number;
  nextAllowedAt?: string;
}

/**
 * Whether a user-triggered (manual button or on-open) refresh of this source
 * should be honored right now. Blocked while a cycle is already running, or if
 * one completed under MIN_MANUAL_REFRESH_MS ago. The background scheduler
 * bypasses this entirely.
 */
export function getRefreshEligibility(listId: string): RefreshEligibility {
  const cp = getCheckpoint(listId);
  if (cp?.lastFetchStatus === "running") {
    return { allowed: false, reason: "running" };
  }
  const last = cp?.lastFetchCompletedAt ? Date.parse(cp.lastFetchCompletedAt) : 0;
  if (last) {
    const elapsed = Date.now() - last;
    if (elapsed < MIN_MANUAL_REFRESH_MS) {
      return {
        allowed: false,
        reason: "recent",
        retryAfterMs: MIN_MANUAL_REFRESH_MS - elapsed,
        nextAllowedAt: new Date(last + MIN_MANUAL_REFRESH_MS).toISOString(),
      };
    }
  }
  return { allowed: true };
}

// Injected once by startTerminal — gates the optional synthesis features.
let features: FeatureFlags = { websiteDiff: true, extraSections: true, aiDigest: true };

export function configureScheduler(flags: FeatureFlags): void {
  features = flags;
}

/**
 * Regenerates a list's rolling digest from its trailing 24h of stories.
 * Shared by the Twitter-list pipeline (runListCycle below) and any other
 * source (e.g. huggingnews.ts) that persists items into the same feed_items
 * table under its own list id. Only called when a cycle actually produced
 * new items, mirroring the "skip the LLM call when nothing changed" cost
 * control used for the main feed-item generation. Failures here are logged,
 * not thrown — the feed items themselves are already safely persisted by the
 * time this runs, so a digest hiccup shouldn't turn a successful cycle into
 * a reported error.
 */
export async function refreshDigest(listId: string, description: string): Promise<void> {
  if (!features.aiDigest) return;
  try {
    const sinceIso = new Date(Date.now() - DIGEST_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const recentItems = getRecentFeedItemsByTimestamp(listId, sinceIso);
    if (recentItems.length === 0) return;

    const bullets = await generateDigest(recentItems, { description });
    if (bullets.length > 0) upsertDigest(listId, bullets, recentItems.length);
  } catch (error) {
    console.warn(`[scheduler] Digest generation failed for ${listId}:`, error);
  }
}

/**
 * Regenerates a list's configured extraSections from its trailing 24h of
 * stories, replacing each section's stored row rather than accumulating a
 * new one every cycle (mirrors refreshDigest exactly). Only called when
 * TwitterListSourceConfig.showExtraSections is truthy — this is an opt-in
 * feature, off by default, so it's never force-shown to anyone viewing a
 * list that merely has extraSections defined.
 */
async function refreshSections(listId: string, description: string, sections: ExtraSection[]): Promise<void> {
  try {
    const sinceIso = new Date(Date.now() - DIGEST_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const recentItems = getRecentFeedItemsByTimestamp(listId, sinceIso);
    if (recentItems.length === 0) return;

    const generated = await generateSections(recentItems, { description }, sections);
    for (const section of generated) {
      upsertSection(listId, section.title, section.content);
    }
  } catch (error) {
    console.warn(`[scheduler] Section synthesis failed for ${listId}:`, error);
  }
}

/**
 * Generic cycle runner for "simple" sources — ones needing no LLM step and no
 * shared-browser-mutex serialization (HuggingNews today; a future RSS feed
 * would likely fit this too): mark running -> fetch already-deduped new
 * items -> insert -> refresh digest -> mark done -> emit, or mark error on
 * failure. Twitter lists keep their own runListCycle below instead, since
 * browser-mutex scraping, raw-tweet dedup, LLM summarization, and
 * auth-failure classification don't fit this generic shape.
 */
export async function runSimpleSourceCycle(
  id: string,
  description: string,
  fetchNewItems: () => Promise<ResolvedFeedItem[]>
): Promise<void> {
  console.log(`[scheduler] Running cycle for ${id}...`);
  markFetchRunning(id);
  emitListUpdate(id, "running");

  try {
    const items = await fetchNewItems();
    console.log(`[scheduler] ${id}: ${items.length} new item(s).`);

    if (items.length === 0) {
      markFetchDone(id, "ok", { newItemCount: 0 });
      emitListUpdate(id, "ok", 0);
      return;
    }

    const batchId = randomUUID();
    insertFeedItems(id, batchId, items);
    await refreshDigest(id, description);

    markFetchDone(id, "ok", { newItemCount: items.length });
    emitListUpdate(id, "ok", items.length);
  } catch (error: any) {
    console.error(`[scheduler] Error processing ${id}:`, error);
    markFetchDone(id, "error", { error: sanitizeErrorForClient(error) });
    emitListUpdate(id, "error", 0);
  }
}

/**
 * Fetches, dedupes, and summarizes one list's new tweets, then persists the
 * result. Shared by the background scheduler loop and the manual-refresh API
 * route so both go through the same browser mutex and can't race each other.
 */
export async function runListCycle(twitter: TwitterClient, config: TwitterListSourceConfig): Promise<void> {
  console.log(`[scheduler] Running cycle for list ${config.id}...`);
  markFetchRunning(config.id);
  emitListUpdate(config.id, "running");

  try {
    const hoursWindow = config.hoursWindow ?? 24;
    const tweets = await browserMutex.run(() => twitter.getListTweets(config.twitterListId, 50, hoursWindow));

    const newTweets = filterNewTweets(tweets);
    console.log(`[scheduler] List ${config.id}: fetched ${tweets.length}, ${newTweets.length} new.`);

    if (newTweets.length === 0) {
      markFetchDone(config.id, "ok", { newItemCount: 0 });
      consecutiveFailures.set(config.id, 0);
      emitListUpdate(config.id, "ok", 0);
      return;
    }

    insertRawTweets(config.id, newTweets);

    const { dumpText, refMap } = buildTweetDump(newTweets);
    const existingCategories = getTopCategories(config.id);
    const drafts = await generateFeedItems(dumpText, config, existingCategories);

    const resolved: ResolvedFeedItem[] = drafts.map((draft) => {
      const sourceTweets = (draft.sourceRefs ?? [])
        .map((ref) => refMap.get(ref))
        .filter((t): t is Tweet => Boolean(t));

      const sourceTweetIds = sourceTweets.map((t) => t.id);
      const sourceUrls = sourceTweets
        .filter((t) => t.author.username)
        .map((t) => `https://x.com/${t.author.username}/status/${t.id}`);

      const itemTimestamp =
        sourceTweets.length > 0
          ? new Date(Math.max(...sourceTweets.map((t) => new Date(t.created_at).getTime()))).toISOString()
          : new Date().toISOString();

      return {
        ...draft,
        category: normalizeCategory(draft.category, existingCategories),
        sourceTweetIds,
        sourceUrls,
        itemTimestamp,
      };
    });

    const batchId = randomUUID();
    insertFeedItems(config.id, batchId, resolved);
    await refreshDigest(config.id, config.description);
    if (features.extraSections && config.showExtraSections && config.extraSections?.length) {
      await refreshSections(config.id, config.description, config.extraSections);
    }

    markFetchDone(config.id, "ok", { newItemCount: resolved.length });
    consecutiveFailures.set(config.id, 0);

    emitListUpdate(config.id, "ok", resolved.length);
  } catch (error: any) {
    const failures = (consecutiveFailures.get(config.id) ?? 0) + 1;
    consecutiveFailures.set(config.id, failures);

    const looksLikeAuthFailure = /login|auth/i.test(String(error?.message ?? ""));
    const status = failures >= AUTH_FAILURE_THRESHOLD || looksLikeAuthFailure ? "auth_expired" : "error";

    console.error(`[scheduler] Error processing list ${config.id}:`, error);
    markFetchDone(config.id, status, { error: sanitizeErrorForClient(error) });
    emitListUpdate(config.id, status, 0);
  }
}

/** Wraps a Twitter list config into a Source for the generic scheduler/server to orchestrate. */
export function createTwitterListSource(twitter: TwitterClient, config: TwitterListSourceConfig): Source {
  return {
    id: config.id,
    type: "twitter_list",
    description: config.description,
    refreshIntervalMinutes: config.refreshIntervalMinutes ?? 30,
    stalenessThresholdHours: resolveStalenessThresholdHours(config),
    runCycle: () => runListCycle(twitter, config),
  };
}

/**
 * Logs a source that keeps completing cycles without producing anything —
 * the server-side half of staleness reporting, so a silently-dead scrape is
 * visible in the logs and not only to whoever has the UI open. The UI's own
 * snack is driven from the same checkpoint fields via /api/lists.
 */
function reportStaleness(source: Source): void {
  const state = evaluateStaleness(getCheckpoint(source.id), source.stalenessThresholdHours);
  if (!state?.stale) return;

  const hours = Math.floor(state.elapsedMs / (60 * 60 * 1000));
  const detail = state.everProduced
    ? `last new item ${hours}h ago (${state.sinceIso})`
    : `never produced an item since ${state.sinceIso}`;
  console.warn(
    `[scheduler] ${source.id} looks stale: ${detail}, past its ${state.thresholdHours}h threshold, ` +
      `yet cycles keep completing without error — the source is probably broken.`
  );
}

/**
 * Starts one independent recursive-timeout loop per source. Uses setTimeout
 * (not setInterval) so the next run is only scheduled once the current one
 * fully completes — Twitter scrapes can take 45-60s+, so setInterval would
 * let cycles pile up in the browser mutex queue. Source-agnostic: works the
 * same for Twitter lists, HuggingNews, or any future source type, since all
 * that's needed is `refreshIntervalMinutes` and `runCycle()`.
 */
export function startScheduler(sources: Source[]): void {
  sources.forEach((source, index) => {
    // Clamp to the max-staleness guarantee: even a source configured with a
    // huge (or missing) interval still refreshes at least once every 24h.
    const effectiveMinutes = Math.min(source.refreshIntervalMinutes, MAX_REFRESH_INTERVAL_MINUTES);
    const intervalMs = effectiveMinutes * 60 * 1000;

    // Both cycle runners catch their own errors, but a throw escaping one
    // would otherwise kill this source's loop for the life of the process —
    // so the reschedule is chained behind a catch, never in front of one.
    const runCycle = (onDone: () => void) => {
      source
        .runCycle()
        .then(() => reportStaleness(source))
        .catch((error) => console.error(`[scheduler] Cycle for ${source.id} threw:`, error))
        .then(onDone);
    };

    const scheduleNext = () => {
      setTimeout(() => runCycle(scheduleNext), intervalMs);
    };

    // Stagger initial kick-off so sources don't all hit the browser mutex at once.
    setTimeout(() => runCycle(scheduleNext), index * 5000);
  });
}
