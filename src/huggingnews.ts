import { hasExternalFeedItem, type ResolvedFeedItem } from "./db.js";
import { runSimpleSourceCycle } from "./scheduler.js";
import { resolveStalenessThresholdHours } from "./staleness.js";
import type { MediaListSourceConfig, Source } from "./types.js";

// Public, source-linked AI news aggregator (https://huggingnews.com) — a
// separate section alongside the Twitter-list-based ones. Unlike those, this
// source needs no scraping or LLM summarization: HuggingNews already returns
// a title/summary/sources per story, so this is just fetch -> dedupe -> map.
// The only implemented "media_list" provider today.

const API_BASE = "https://api.huggingnews.com/api/stories";
const REQUEST_TIMEOUT_MS = 20_000;

// Injected once by startTerminal — optional; anonymous access works without it.
let apiKey: string | undefined;

export function configureHuggingNews(key: string | undefined): void {
  apiKey = key;
}

interface HuggingNewsTopicTag {
  slug: string;
  name: string;
}

interface HuggingNewsStoryStub {
  slug: string;
  title: string;
  publishedAt: number;
  eventTimeApprox?: number;
  topicTags: HuggingNewsTopicTag[];
}

interface HuggingNewsStoryDetail extends HuggingNewsStoryStub {
  summary: string;
  selectedTweets?: Array<{ url?: string }>;
}

function authHeaders(): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function fetchLatestStubs(): Promise<HuggingNewsStoryStub[]> {
  const res = await fetch(API_BASE, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HuggingNews API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return (data.dayGroups ?? []).flatMap((group: any) => group.stories ?? []);
}

async function fetchStoryDetail(slug: string): Promise<HuggingNewsStoryDetail> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(slug)}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HuggingNews detail error for ${slug}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchNewHuggingNewsItems(sourceId: string): Promise<ResolvedFeedItem[]> {
  const stubs = await fetchLatestStubs();
  const newStubs = stubs.filter((s) => !hasExternalFeedItem(sourceId, s.slug));
  console.log(`[huggingnews] Fetched ${stubs.length}, ${newStubs.length} new.`);

  const resolved: ResolvedFeedItem[] = [];
  for (const stub of newStubs) {
    const detail = await fetchStoryDetail(stub.slug);
    const sourceUrls = [
      `https://huggingnews.com/ai/${detail.slug}`,
      ...(detail.selectedTweets ?? []).map((t) => t.url).filter((url): url is string => Boolean(url)),
    ];

    // Every story carries the redundant root "ai" tag first (per the
    // skill's own docs), so skip it in favor of a more specific one for
    // the category filter — otherwise every item lands in one "AI" bucket.
    const specificTags = (detail.topicTags ?? []).filter((t) => t.slug !== "ai");

    resolved.push({
      type: "tweet_update",
      headline: detail.title,
      summary: detail.summary,
      category: specificTags[0]?.name ?? detail.topicTags?.[0]?.name,
      tags: detail.topicTags?.map((t) => t.name) ?? [],
      sourceTweetIds: [],
      sourceUrls,
      itemTimestamp: new Date(detail.eventTimeApprox ?? detail.publishedAt).toISOString(),
      externalId: detail.slug,
    });
  }

  return resolved;
}

/**
 * Fetches the latest story list, fetches full detail (summary + sources)
 * only for slugs not already stored, and persists them as feed items under
 * this source's own id — the same shape the Twitter-list pipeline produces,
 * so the existing feed UI renders this section with no changes. Delegates
 * the mark-running/insert/refreshDigest/emit/error boilerplate to the
 * generic runSimpleSourceCycle, since this source needs no LLM step.
 */
function runHuggingNewsCycle(config: MediaListSourceConfig): Promise<void> {
  return runSimpleSourceCycle(config.id, config.description, () => fetchNewHuggingNewsItems(config.id));
}

/**
 * Registers a "media_list" source as a Source for the generic scheduler/server
 * to orchestrate. HuggingNews is the only implemented provider today — a
 * future one would add its own fetch/map logic and a case here.
 */
export function createMediaListSource(config: MediaListSourceConfig): Source {
  if (config.provider !== "huggingnews") {
    throw new Error(`Unknown media_list provider "${config.provider}" for source "${config.id}".`);
  }
  return {
    id: config.id,
    type: "media_list",
    description: config.description,
    refreshIntervalMinutes: config.refreshIntervalMinutes ?? 20,
    stalenessThresholdHours: resolveStalenessThresholdHours(config),
    runCycle: () => runHuggingNewsCycle(config),
  };
}
