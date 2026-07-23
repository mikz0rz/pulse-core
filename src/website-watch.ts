import { createHash } from "crypto";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser } from "puppeteer";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { diffLines } from "diff";
import {
  hasExternalFeedItem,
  getWebsiteSnapshot,
  upsertWebsiteSnapshot,
  getTopCategories,
  normalizeCategory,
  type ResolvedFeedItem,
} from "./db.js";
import { runSimpleSourceCycle } from "./scheduler.js";
import { summarizeWebsiteDiff } from "./summarizer.js";
import type { RssFeedSourceConfig, Source, WebsiteDiffSourceConfig } from "./types.js";

const puppeteer = puppeteerExtra as any;
puppeteer.use(StealthPlugin());

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NAV_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 6_000;

const rssParser = new Parser();

// Independent from TwitterClient's browser: that one is tightly bound to an
// authenticated x.com session and shouldn't navigate to third-party domains.
// A fresh Page per check (not reused) means no session state to preserve
// and no need for a shared mutex — different sites' checks don't interfere.
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;
  console.log("[website-watch] Launching browser...");
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1440, height: 900 },
  });
  return browser!;
}

export async function closeWebsiteBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

function extractText(html: string, selector?: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, noscript").remove();
  const scoped = selector ? $(selector) : $("body");
  const text = (scoped.length > 0 ? scoped : $("body")).text();
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function stripHtml(html: string): string {
  return cheerio
    .load(html)
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchRenderedText(url: string, selector?: string): Promise<string> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    const html = await page.content();
    return extractText(html, selector);
  } finally {
    await page.close();
  }
}

function buildDiffText(oldText: string, newText: string): string {
  const changes = diffLines(oldText, newText);
  const lines: string[] = [];
  for (const part of changes) {
    if (!part.added && !part.removed) continue;
    const prefix = part.added ? "+" : "-";
    for (const line of part.value.split("\n")) {
      if (line.trim().length === 0) continue;
      lines.push(`${prefix} ${line.trim()}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > MAX_DIFF_CHARS ? `${joined.slice(0, MAX_DIFF_CHARS)}\n...(truncated)` : joined;
}

/**
 * Blogs/changelogs with an RSS/Atom feed: new posts are detected via the
 * feed itself (reliable, no scraping fragility) and dedupe reuses the same
 * external_id mechanism HuggingNews already uses. No LLM call per item —
 * the feed's own title/description is trusted, same as HuggingNews.
 */
async function checkFeedSite(config: RssFeedSourceConfig): Promise<ResolvedFeedItem[]> {
  const feed = await rssParser.parseURL(config.feedUrl);
  const items: ResolvedFeedItem[] = [];

  for (const item of feed.items ?? []) {
    const externalId = item.guid ?? item.link;
    if (!externalId || hasExternalFeedItem(config.id, externalId)) continue;

    const summary = item.contentSnippet ?? stripHtml(item.content ?? item.summary ?? "");
    items.push({
      type: "tweet_update",
      headline: item.title ?? "Untitled post",
      summary,
      tags: [],
      sourceTweetIds: [],
      sourceUrls: item.link ? [item.link] : [],
      itemTimestamp: item.isoDate ?? new Date().toISOString(),
      externalId,
    });
  }

  console.log(`[website-watch] ${config.id}: ${feed.items?.length ?? 0} in feed, ${items.length} new.`);
  return items;
}

/**
 * Pages with no feed (pricing, product, careers, ...): renders the page,
 * extracts+normalizes its text, and hashes it. First check just establishes
 * a baseline (nothing to report yet). A hash change triggers a line-level
 * diff, which the LLM turns into one readable "what changed" feed item.
 */
async function checkDiffSite(config: WebsiteDiffSourceConfig): Promise<ResolvedFeedItem[]> {
  const newText = await fetchRenderedText(config.url, config.selector);
  const contentHash = createHash("sha256").update(newText).digest("hex");

  const prev = getWebsiteSnapshot(config.id);
  if (!prev) {
    console.log(`[website-watch] ${config.id}: no prior snapshot, storing baseline.`);
    upsertWebsiteSnapshot(config.id, contentHash, newText);
    return [];
  }

  if (prev.contentHash === contentHash) {
    return [];
  }

  const diffText = buildDiffText(prev.content, newText);
  upsertWebsiteSnapshot(config.id, contentHash, newText);
  if (diffText.length === 0) return [];

  const existingCategories = getTopCategories(config.id);
  const { headline, summary, category } = await summarizeWebsiteDiff(
    config.description,
    config.url,
    diffText,
    existingCategories
  );

  return [
    {
      type: "tweet_update",
      headline,
      summary,
      category: normalizeCategory(category, existingCategories),
      tags: [],
      sourceTweetIds: [],
      sourceUrls: [config.url],
      itemTimestamp: new Date().toISOString(),
      externalId: contentHash,
    },
  ];
}

/** Registers a blog/changelog RSS feed as a Source. Cheap to poll (~60min default) — just an XML fetch. */
export function createRssFeedSource(config: RssFeedSourceConfig): Source {
  return {
    id: config.id,
    type: "rss_feed",
    description: config.description,
    refreshIntervalMinutes: config.refreshIntervalMinutes ?? 60,
    runCycle: () => runSimpleSourceCycle(config.id, config.description, () => checkFeedSite(config)),
  };
}

/** Registers a watched page as a Source. Conservative default interval (~3h) since each check is a full JS-rendered page load. */
export function createWebsiteDiffSource(config: WebsiteDiffSourceConfig): Source {
  return {
    id: config.id,
    type: "website_diff",
    description: config.description,
    refreshIntervalMinutes: config.refreshIntervalMinutes ?? 180,
    runCycle: () => runSimpleSourceCycle(config.id, config.description, () => checkDiffSite(config)),
  };
}
