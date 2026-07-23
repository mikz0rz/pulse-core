export interface Tweet {
  id: string;
  text: string;
  author: {
    id: string;
    username: string;
    name: string;
    profile_image_url?: string;
    verified?: boolean;
  };
  created_at: string;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  views?: number;
  language?: string;
  in_reply_to_tweet_id?: string;
  conversation_id?: string;
  media?: Array<{
    type: string;
    url: string;
    preview_url?: string;
  }>;
}

export interface UserProfile {
  id: string;
  username: string;
  name: string;
  description: string;
  profile_image_url: string;
  profile_banner_url?: string;
  followers_count: number;
  following_count: number;
  tweet_count: number;
  verified: boolean;
  created_at: string;
  location?: string;
  url?: string;
}

export interface TrendItem {
  name: string;
  tweet_count?: number;
  description?: string;
  domain?: string;
}

export interface ExtraSection {
  title: string;
  instruction: string;
}

// Every source lives in one sources.json, discriminated by `type` — the
// "abstracted category" a source belongs to. Adding a new category (a fifth
// type) means adding a variant here, a config-loading branch in
// sources-config.ts if it needs bespoke defaults, and a factory case in
// sources.ts — no changes needed to the scheduler, server, or frontend.
export type SourceType = "twitter_list" | "media_list" | "rss_feed" | "website_diff";

interface BaseSourceConfig {
  id: string;
  type: SourceType;
  description: string;
  refreshIntervalMinutes?: number;
  enabled: boolean;
}

export interface TwitterListSourceConfig extends BaseSourceConfig {
  type: "twitter_list";
  twitterListId: string;
  promptContext?: string;
  extraSections?: ExtraSection[];
  showExtraSections?: boolean; // opt-in gate for extraSections synthesis — undefined/false = off, so it's never force-shown by default
  hoursWindow?: number; // How far back to look on a list's first-ever fetch
}

export interface MediaListSourceConfig extends BaseSourceConfig {
  type: "media_list";
  provider: "huggingnews"; // only implemented provider today; a future one adds a value here + a matching case in sources.ts
}

export interface RssFeedSourceConfig extends BaseSourceConfig {
  type: "rss_feed";
  feedUrl: string;
  url?: string; // informational "home" link, shown as the story's site link
}

export interface WebsiteDiffSourceConfig extends BaseSourceConfig {
  type: "website_diff";
  url: string;
  selector?: string; // CSS selector scoping content extraction — falls back to <body>
}

export type SourceConfig = TwitterListSourceConfig | MediaListSourceConfig | RssFeedSourceConfig | WebsiteDiffSourceConfig;

export type FeedItemType = "tweet_update";

// What the LLM returns per item — source attribution is by local ref key
// (e.g. "T3"), never a URL, so the server (not the model) builds real links.
export interface FeedItemDraft {
  type: FeedItemType;
  brand?: string;
  headline: string;
  summary: string;
  category?: string;
  tags?: string[];
  sourceRefs?: string[];
}

export interface FeedItem {
  id: number;
  listId: string;
  batchId: string;
  type: FeedItemType;
  brand?: string;
  headline: string;
  summary: string;
  category?: string;
  tags: string[];
  sourceTweetIds: string[];
  sourceUrls: string[];
  itemTimestamp: string;
  createdAt: string;
}

export type ListFetchStatus = "ok" | "error" | "running" | "auth_expired";

export interface ListCheckpoint {
  listId: string;
  lastFetchStartedAt?: string;
  lastFetchCompletedAt?: string;
  lastFetchStatus?: ListFetchStatus;
  lastError?: string;
}

export interface ListDigest {
  listId: string;
  bullets: string[];
  generatedAt: string;
  itemCount: number;
}

// A list's rolling, replacing synthesis for one configured extraSection
// title — regenerated in place (never accumulated) each cycle, gated by
// TwitterListSourceConfig.showExtraSections.
export interface ListSection {
  listId: string;
  title: string;
  content: string;
  generatedAt: string;
}

// The generic contract every source type (Twitter list, HuggingNews, future
// RSS/website-diff sources, ...) implements so the scheduler and server can
// orchestrate them uniformly without special-casing by id.
export interface Source {
  id: string;
  type: SourceType;
  description: string;
  refreshIntervalMinutes: number;
  runCycle(): Promise<void>;
}
