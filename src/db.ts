import Database from "better-sqlite3";
import type { Tweet, FeedItem, FeedItemDraft, ListCheckpoint, ListFetchStatus, ListDigest, ListSection } from "./types.js";

// The database path is injected by the consumer via startTerminal() → initDb();
// the core never reads it from the environment. Everything is lazily created
// inside initDb so the path can be supplied at runtime rather than import time.
let db: Database.Database;

let existingTweetStmt: Database.Statement;
let insertTweetStmt: Database.Statement;
let insertTweetsTx: Database.Transaction;
let insertFeedItemStmt: Database.Statement;
let insertFeedItemsTx: Database.Transaction;
let existingExternalIdStmt: Database.Statement;
let upsertCheckpointStmt: Database.Statement;
let upsertDigestStmt: Database.Statement;
let upsertWebsiteSnapshotStmt: Database.Statement;
let upsertSectionStmt: Database.Statement;

export function initDb(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_tweets (
      tweet_id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      author_username TEXT,
      author_name TEXT,
      created_at_raw TEXT,
      created_at_iso TEXT,
      text TEXT,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_raw_tweets_list_created ON raw_tweets(list_id, created_at_iso);

    CREATE TABLE IF NOT EXISTS feed_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      type TEXT NOT NULL,
      brand TEXT,
      headline TEXT NOT NULL,
      summary TEXT,
      category TEXT,
      tags_json TEXT,
      source_tweet_ids_json TEXT,
      source_urls_json TEXT,
      item_timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feed_items_list_created ON feed_items(list_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS list_checkpoints (
      list_id TEXT PRIMARY KEY,
      last_fetch_started_at TEXT,
      last_fetch_completed_at TEXT,
      last_fetch_status TEXT,
      last_error TEXT,
      last_item_at TEXT,
      watching_since TEXT
    );

    CREATE TABLE IF NOT EXISTS list_digests (
      list_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      item_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS website_snapshots (
      website_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_sections (
      list_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (list_id, title)
    );
  `);

  // Legacy cleanup: section takeaways used to be stored as type='section'
  // feed_items and accumulated forever; they're now a rolling list_sections
  // synthesis. Nothing inserts type='section' anymore, so clear the pile-up.
  db.exec("DELETE FROM feed_items WHERE type = 'section'");

  // Non-tweet sources dedupe by their own stable id.
  const feedItemColumns = db.prepare("PRAGMA table_info(feed_items)").all() as Array<{ name: string }>;
  if (!feedItemColumns.some((c) => c.name === "external_id")) {
    db.exec("ALTER TABLE feed_items ADD COLUMN external_id TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_items_external ON feed_items(list_id, external_id) WHERE external_id IS NOT NULL"
  );

  // Staleness tracking (see staleness.ts) added after the fact, so existing
  // databases get the columns here. Both are backfilled from the feed itself
  // rather than left NULL — otherwise every already-broken source would look
  // freshly-watched and stay unreported for another threshold window.
  const checkpointColumns = db.prepare("PRAGMA table_info(list_checkpoints)").all() as Array<{ name: string }>;
  const hasCheckpointColumn = (name: string) => checkpointColumns.some((c) => c.name === name);
  if (!hasCheckpointColumn("last_item_at")) {
    db.exec("ALTER TABLE list_checkpoints ADD COLUMN last_item_at TEXT");
    db.exec(`
      UPDATE list_checkpoints SET last_item_at =
        (SELECT MAX(created_at) FROM feed_items WHERE feed_items.list_id = list_checkpoints.list_id)
    `);
  }
  if (!hasCheckpointColumn("watching_since")) {
    db.exec("ALTER TABLE list_checkpoints ADD COLUMN watching_since TEXT");
    db.exec(`
      UPDATE list_checkpoints SET watching_since = COALESCE(
        (SELECT MIN(created_at) FROM feed_items WHERE feed_items.list_id = list_checkpoints.list_id),
        last_fetch_completed_at,
        last_fetch_started_at
      )
    `);
  }

  normalizeCategoryCasingDuplicates();

  existingTweetStmt = db.prepare("SELECT 1 FROM raw_tweets WHERE tweet_id = ?");
  insertTweetStmt = db.prepare(`
    INSERT OR IGNORE INTO raw_tweets
      (tweet_id, list_id, author_username, author_name, created_at_raw, created_at_iso, text, raw_json, fetched_at)
    VALUES (@tweet_id, @list_id, @author_username, @author_name, @created_at_raw, @created_at_iso, @text, @raw_json, @fetched_at)
  `);
  insertTweetsTx = db.transaction((listId: string, tweets: Tweet[]) => {
    const fetchedAt = new Date().toISOString();
    for (const t of tweets) {
      insertTweetStmt.run({
        tweet_id: t.id,
        list_id: listId,
        author_username: t.author.username ?? null,
        author_name: t.author.name ?? null,
        created_at_raw: t.created_at,
        created_at_iso: new Date(t.created_at).toISOString(),
        text: t.text,
        raw_json: JSON.stringify(t),
        fetched_at: fetchedAt,
      });
    }
  });
  insertFeedItemStmt = db.prepare(`
    INSERT OR IGNORE INTO feed_items
      (list_id, batch_id, type, brand, headline, summary, category, tags_json, source_tweet_ids_json, source_urls_json, item_timestamp, created_at, external_id)
    VALUES (@list_id, @batch_id, @type, @brand, @headline, @summary, @category, @tags_json, @source_tweet_ids_json, @source_urls_json, @item_timestamp, @created_at, @external_id)
  `);
  insertFeedItemsTx = db.transaction((listId: string, batchId: string, items: ResolvedFeedItem[]) => {
    const createdAt = new Date().toISOString();
    for (const item of items) {
      insertFeedItemStmt.run({
        list_id: listId,
        batch_id: batchId,
        type: item.type,
        brand: item.brand ?? null,
        headline: item.headline,
        summary: item.summary ?? null,
        category: item.category ?? null,
        tags_json: JSON.stringify(item.tags ?? []),
        source_tweet_ids_json: JSON.stringify(item.sourceTweetIds),
        source_urls_json: JSON.stringify(item.sourceUrls),
        item_timestamp: item.itemTimestamp,
        created_at: createdAt,
        external_id: item.externalId ?? null,
      });
    }
  });
  existingExternalIdStmt = db.prepare("SELECT 1 FROM feed_items WHERE list_id = ? AND external_id = ?");
  upsertCheckpointStmt = db.prepare(`
    INSERT INTO list_checkpoints
      (list_id, last_fetch_started_at, last_fetch_completed_at, last_fetch_status, last_error, last_item_at, watching_since)
    VALUES
      (@list_id, @last_fetch_started_at, @last_fetch_completed_at, @last_fetch_status, @last_error, @last_item_at, @watching_since)
    ON CONFLICT(list_id) DO UPDATE SET
      last_fetch_started_at = COALESCE(excluded.last_fetch_started_at, last_fetch_started_at),
      last_fetch_completed_at = COALESCE(excluded.last_fetch_completed_at, last_fetch_completed_at),
      last_fetch_status = COALESCE(excluded.last_fetch_status, last_fetch_status),
      last_error = excluded.last_error,
      last_item_at = COALESCE(excluded.last_item_at, last_item_at),
      -- Reversed COALESCE vs. the rest: watching_since is write-once, so the
      -- existing value wins and every later cycle leaves it untouched.
      watching_since = COALESCE(watching_since, excluded.watching_since)
  `);
  upsertDigestStmt = db.prepare(`
    INSERT INTO list_digests (list_id, summary, generated_at, item_count)
    VALUES (@list_id, @summary, @generated_at, @item_count)
    ON CONFLICT(list_id) DO UPDATE SET
      summary = excluded.summary,
      generated_at = excluded.generated_at,
      item_count = excluded.item_count
  `);
  upsertWebsiteSnapshotStmt = db.prepare(`
    INSERT INTO website_snapshots (website_id, content_hash, content, updated_at)
    VALUES (@website_id, @content_hash, @content, @updated_at)
    ON CONFLICT(website_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      content = excluded.content,
      updated_at = excluded.updated_at
  `);
  upsertSectionStmt = db.prepare(`
    INSERT INTO list_sections (list_id, title, content, generated_at)
    VALUES (@list_id, @title, @content, @generated_at)
    ON CONFLICT(list_id, title) DO UPDATE SET
      content = excluded.content,
      generated_at = excluded.generated_at
  `);
}

// One-time (idempotent) merge of categories that differ only by casing.
function normalizeCategoryCasingDuplicates(): void {
  const rows = db
    .prepare(
      `SELECT list_id as listId, category, COUNT(*) as count
       FROM feed_items
       WHERE category IS NOT NULL AND category != ''
       GROUP BY list_id, category`
    )
    .all() as Array<{ listId: string; category: string; count: number }>;

  const groups = new Map<string, Array<{ listId: string; category: string; count: number }>>();
  for (const row of rows) {
    const key = `${row.listId}::${row.category.trim().toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const isTitleCase = (s: string) =>
    s === s.replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  const updateStmt = db.prepare(`UPDATE feed_items SET category = @canonical WHERE list_id = @listId AND category = @variant`);
  for (const variants of groups.values()) {
    if (variants.length <= 1) continue;
    const [canonicalRow] = [...variants].sort(
      (a, b) =>
        b.count - a.count ||
        Number(isTitleCase(b.category)) - Number(isTitleCase(a.category)) ||
        a.category.length - b.category.length ||
        a.category.localeCompare(b.category)
    );
    for (const v of variants) {
      if (v.category === canonicalRow.category) continue;
      updateStmt.run({ canonical: canonicalRow.category, listId: v.listId, variant: v.category });
    }
  }
}

/** Returns only the tweets not already stored, without inserting them. */
export function filterNewTweets(tweets: Tweet[]): Tweet[] {
  return tweets.filter((t) => !existingTweetStmt.get(t.id));
}

export function insertRawTweets(listId: string, tweets: Tweet[]): void {
  if (tweets.length === 0) return;
  insertTweetsTx(listId, tweets);
}

export interface ResolvedFeedItem extends FeedItemDraft {
  sourceTweetIds: string[];
  sourceUrls: string[];
  itemTimestamp: string;
  externalId?: string;
}

export function insertFeedItems(listId: string, batchId: string, items: ResolvedFeedItem[]): void {
  if (items.length === 0) return;
  insertFeedItemsTx(listId, batchId, items);
}

/** For non-Twitter sources that dedupe by their own stable id instead of via raw_tweets. */
export function hasExternalFeedItem(listId: string, externalId: string): boolean {
  return Boolean(existingExternalIdStmt.get(listId, externalId));
}

function rowToFeedItem(row: any): FeedItem {
  return {
    id: row.id,
    listId: row.list_id,
    batchId: row.batch_id,
    type: row.type,
    brand: row.brand ?? undefined,
    headline: row.headline,
    summary: row.summary ?? "",
    category: row.category ?? undefined,
    tags: JSON.parse(row.tags_json ?? "[]"),
    sourceTweetIds: JSON.parse(row.source_tweet_ids_json ?? "[]"),
    sourceUrls: JSON.parse(row.source_urls_json ?? "[]"),
    itemTimestamp: row.item_timestamp,
    createdAt: row.created_at,
  };
}

export function getFeedItems(opts: { listId?: string; since?: string; limit?: number } = {}): FeedItem[] {
  const limit = opts.limit ?? 100;
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit };

  if (opts.listId) {
    clauses.push("list_id = @listId");
    params.listId = opts.listId;
  }
  if (opts.since) {
    clauses.push("created_at > @since");
    params.since = opts.since;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM feed_items ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`)
    .all(params);
  return rows.map(rowToFeedItem);
}

/** The list's most-used category labels, most frequent first — fed back to the LLM so it reuses existing labels instead of inventing near-duplicates. */
export function getTopCategories(listId: string, limit = 20): string[] {
  const rows = db
    .prepare(
      `SELECT category FROM feed_items
       WHERE list_id = ? AND category IS NOT NULL AND category != ''
       GROUP BY category
       ORDER BY COUNT(*) DESC
       LIMIT ?`
    )
    .all(listId, limit) as Array<{ category: string }>;
  return rows.map((r) => r.category);
}

/** Deterministic safety net: snap an LLM-returned category to an existing case-insensitive match. */
export function normalizeCategory(category: string | undefined, existingCategories: string[]): string | undefined {
  if (!category) return category;
  const trimmed = category.trim();
  if (!trimmed) return undefined;
  const match = existingCategories.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  return match ?? trimmed;
}

/** Feed items whose real content time falls within the window — used for the rolling digest/sections. */
export function getRecentFeedItemsByTimestamp(listId: string, sinceIso: string): FeedItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM feed_items WHERE list_id = @listId AND type = 'tweet_update' AND item_timestamp >= @since ORDER BY item_timestamp DESC`
    )
    .all({ listId, since: sinceIso });
  return rows.map(rowToFeedItem);
}

function rowToCheckpoint(row: any): ListCheckpoint {
  return {
    listId: row.list_id,
    lastFetchStartedAt: row.last_fetch_started_at ?? undefined,
    lastFetchCompletedAt: row.last_fetch_completed_at ?? undefined,
    lastFetchStatus: row.last_fetch_status ?? undefined,
    lastError: row.last_error ?? undefined,
    lastItemAt: row.last_item_at ?? undefined,
    watchingSince: row.watching_since ?? undefined,
  };
}

export function getCheckpoint(listId: string): ListCheckpoint | undefined {
  const row = db.prepare("SELECT * FROM list_checkpoints WHERE list_id = ?").get(listId);
  return row ? rowToCheckpoint(row) : undefined;
}

export function getAllCheckpoints(): ListCheckpoint[] {
  const rows = db.prepare("SELECT * FROM list_checkpoints").all();
  return rows.map(rowToCheckpoint);
}

export function markFetchRunning(listId: string): void {
  const now = new Date().toISOString();
  upsertCheckpointStmt.run({
    list_id: listId,
    last_fetch_started_at: now,
    last_fetch_completed_at: null,
    last_fetch_status: "running" as ListFetchStatus,
    last_error: null,
    last_item_at: null, // NULL keeps the stored value (see the upsert's COALESCE)
    watching_since: now, // write-once: only lands on the source's very first cycle
  });
}

export interface FetchDoneOptions {
  error?: string;
  /**
   * How many items this cycle actually inserted. A positive count is what
   * advances `last_item_at` — 0 deliberately leaves it where it was, which is
   * how a run of empty-but-successful cycles becomes visible as staleness.
   */
  newItemCount?: number;
}

export function markFetchDone(listId: string, status: ListFetchStatus, opts: FetchDoneOptions = {}): void {
  const now = new Date().toISOString();
  const produced = (opts.newItemCount ?? 0) > 0;
  upsertCheckpointStmt.run({
    list_id: listId,
    last_fetch_started_at: null,
    last_fetch_completed_at: now,
    last_fetch_status: status,
    last_error: opts.error ?? null,
    last_item_at: produced ? now : null,
    watching_since: now,
  });
}

export function upsertDigest(listId: string, bullets: string[], itemCount: number): void {
  upsertDigestStmt.run({
    list_id: listId,
    summary: JSON.stringify(bullets),
    generated_at: new Date().toISOString(),
    item_count: itemCount,
  });
}

export interface WebsiteSnapshot {
  websiteId: string;
  contentHash: string;
  content: string;
  updatedAt: string;
}

export function upsertWebsiteSnapshot(websiteId: string, contentHash: string, content: string): void {
  upsertWebsiteSnapshotStmt.run({
    website_id: websiteId,
    content_hash: contentHash,
    content,
    updated_at: new Date().toISOString(),
  });
}

export function getWebsiteSnapshot(websiteId: string): WebsiteSnapshot | undefined {
  const row: any = db.prepare("SELECT * FROM website_snapshots WHERE website_id = ?").get(websiteId);
  if (!row) return undefined;
  return {
    websiteId: row.website_id,
    contentHash: row.content_hash,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

export function getDigest(listId: string): ListDigest | undefined {
  const row: any = db.prepare("SELECT * FROM list_digests WHERE list_id = ?").get(listId);
  if (!row) return undefined;

  let bullets: string[];
  try {
    bullets = JSON.parse(row.summary);
  } catch {
    bullets = row.summary ? [row.summary] : [];
  }

  return {
    listId: row.list_id,
    bullets,
    generatedAt: row.generated_at,
    itemCount: row.item_count,
  };
}

/** Replaces (never accumulates) a list's rolling synthesis for one configured extraSection title. */
export function upsertSection(listId: string, title: string, content: string): void {
  upsertSectionStmt.run({ list_id: listId, title, content, generated_at: new Date().toISOString() });
}

export function getSections(listId: string): ListSection[] {
  const rows = db.prepare("SELECT * FROM list_sections WHERE list_id = ? ORDER BY title").all(listId) as any[];
  return rows.map((row) => ({
    listId: row.list_id,
    title: row.title,
    content: row.content,
    generatedAt: row.generated_at,
  }));
}
