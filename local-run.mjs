// Throwaway local runner to see the terminal live from inside this repo.
// Runs against the already-built engine in ./build — no compile step needed.
//   npm run build   # only if build/ or frontend/dist/ is stale
//   node local-run.mjs
// Reads secrets from a local .env (gitignored). Fill in .env, then run.
// Then open the port and log in with APP_PASSWORD (default "changeme").

import "dotenv/config";
import { startTerminal } from "./build/index.js";

const twitterAuth = process.env.TWITTER_AUTH_TOKEN || "";
const twitterCt0 = process.env.TWITTER_CT0 || "";
const llmApiKey = process.env.LLM_API_KEY || "";

const haveCreds = Boolean(twitterAuth && twitterCt0);
const haveLlm = Boolean(llmApiKey);

// Refresh policy: background cadence = 24h (the max-staleness floor). We do NOT
// poll sources frequently — freshness comes from the on-visit refresh, which is
// rate-limited to once per 15 min per source (the "Refresh now" button also
// locks out for 15 min). Between refreshes, feed items are served from the
// SQLite store, so repeat views cost nothing and never re-scrape.
const REFRESH_MINUTES = 24 * 60;

const sources = [
  // Zero-secret blog feed — always on.
  {
    type: "rss_feed",
    id: "so-blog",
    description: "Stack Overflow Blog",
    feedUrl: "https://stackoverflow.blog/feed/",
    refreshIntervalMinutes: REFRESH_MINUTES,
    enabled: true,
  },
  // HuggingNews AI aggregator — anonymous access, no key needed. Already
  // returns title/summary/sources per story, so no scrape or LLM step.
  {
    type: "media_list",
    id: "huggingnews",
    description: "HuggingNews (AI)",
    provider: "huggingnews",
    refreshIntervalMinutes: REFRESH_MINUTES,
    enabled: true,
  },
];

// Twitter lists: add a row per list. Each activates only if its *_ID env is
// set AND cookies are present. Drives the full scrape -> LLM-summarize path.
const twitterLists = [
  { sourceId: "x-list", idEnv: "TWITTER_LIST_ID", nameEnv: "TWITTER_LIST_NAME" },
  { sourceId: "x-list-2", idEnv: "TWITTER_LIST_ID_2", nameEnv: "TWITTER_LIST_NAME_2" },
];
for (const l of twitterLists) {
  const listId = process.env[l.idEnv] || "";
  if (!listId) continue;
  if (!haveCreds) {
    console.log(`[local-run] ${l.idEnv} set but no cookies — skipping ${l.sourceId}`);
    continue;
  }
  sources.push({
    type: "twitter_list",
    id: l.sourceId,
    description: process.env[l.nameEnv] || l.sourceId,
    twitterListId: listId,
    refreshIntervalMinutes: REFRESH_MINUTES,
    hoursWindow: 24, // how far back on the first-ever fetch
    enabled: true,
  });
  console.log(`[local-run] twitter_list ENABLED: ${l.sourceId} (${listId})`);
}

if (!haveLlm) {
  console.log("[local-run] no LLM_API_KEY — aiDigest off and tweet summaries can't run. Set LLM_API_KEY in .env");
}

startTerminal({
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || "./pulse.local.db",
  appPassword: process.env.APP_PASSWORD || "changeme",
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
  secureCookie: false, // local http

  llm: {
    provider: process.env.LLM_PROVIDER || "gemini", // "gemini" | "openai"
    apiKey: llmApiKey,
    baseUrl: process.env.OPENAI_BASE_URL, // OpenAI-compatible gateways only
    modelId: process.env.LLM_MODEL_ID || process.env.OPENAI_MODEL_ID,
  },
  twitter: { authToken: twitterAuth, ct0: twitterCt0 },
  huggingNewsApiKey: process.env.HUGGINGNEWS_API_KEY, // optional; anonymous works

  sources,

  // Digest turns on automatically once an LLM key is present.
  features: { websiteDiff: false, extraSections: false, aiDigest: haveLlm },
  branding: { title: "Pulse (local)" },
});
