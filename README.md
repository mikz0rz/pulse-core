# pulse-core

A composable **news-terminal engine**. It fetches from multiple source types, turns new content into structured feed items with an LLM, dedupes and stores them in SQLite, and serves a live, password-protected web feed (Express API + Server-Sent Events + a bundled React UI).

Source types out of the box:

- **`twitter_list`** — scrape a Twitter/X List (cookie-based, no official API) and LLM-summarize new tweets
- **`media_list`** — a curated external aggregator (a HuggingNews provider ships built in)
- **`rss_feed`** — poll a blog/changelog RSS or Atom feed
- **`website_diff`** — periodically diff a page's content and summarize what changed

It's designed to be composed, not forked: **bring your own API keys and config** — the engine reads nothing from the environment itself. Everything (LLM keys, cookies, the app password, feature flags, sources) is passed in through one call.

## Install

```jsonc
// package.json — reference the engine straight from GitHub
{
  "dependencies": {
    "pulse-core": "github:<your-gh-user>/pulse-core#main"
  }
}
```

`pulse-core` builds itself (backend + bundled UI) on install via its `prepare` script.

## Usage

```ts
import { startTerminal, type SourceConfig } from "pulse-core";

const sources: SourceConfig[] = [
  { type: "rss_feed", id: "example-blog", description: "Example Blog",
    feedUrl: "https://example.com/rss.xml", refreshIntervalMinutes: 60, enabled: true },
];

startTerminal({
  port: 3000,
  dbPath: "./data.db",
  appPassword: process.env.APP_PASSWORD!,       // you supply the secret
  sessionSecret: process.env.SESSION_SECRET!,    // you supply the secret
  secureCookie: true,                            // behind TLS in production
  llm: { provider: "gemini", apiKey: process.env.GEMINI_API_KEY! },
  twitter: { authToken: process.env.TWITTER_AUTH_TOKEN!, ct0: process.env.TWITTER_CT0! },
  sources,
  features: { websiteDiff: true, extraSections: false, aiDigest: true },
  branding: { title: "News Terminal" },
});
```

Then open the port, log in with your `appPassword`, and configured sources populate on their own schedules. See [`examples/standalone.ts`](./examples/standalone.ts) for a runnable single-file version.

## Running your own deployment

The engine doesn't run itself — you write a tiny deploy repo that supplies your
secrets/sources and calls `startTerminal()`. Two ways in:

- **Copy [`examples/deploy-template/`](./examples/deploy-template)** into a new repo — a complete, secret-free starter (thin entry, `sources.json`, `.env.example`, `Dockerfile`). Fill it in and run.
- **Read [DEPLOYMENT.md](./DEPLOYMENT.md)** for the full path: single site → multiple site variants from one repo → keeping private "secret sauce" (custom prompts/ranking) out of the public engine via extension points → Docker/VPS → version pinning.

The design intent is **open core**: publish this engine, keep your deployment (with its real keys and sources) in a separate private repo that depends on it.

## Bring your own API keys and config

The engine never reads secrets from `process.env` — the caller injects them via `startTerminal(options)`:

| Option | Purpose |
|---|---|
| `twitter.authToken` / `twitter.ct0` | cookies from a logged-in x.com session (for `twitter_list`) |
| `llm.provider` / `llm.apiKey` / `llm.baseUrl` / `llm.modelId` | LLM for summaries (OpenAI-compatible or Gemini) |
| `appPassword` / `sessionSecret` | single-user login for the web UI |
| `dbPath` | where the SQLite file lives |
| `huggingNewsApiKey` | optional, for the `media_list` HuggingNews provider |

## Feature flags

`features` turns capabilities on per deployment — the engine exposes them; the consumer decides:

```ts
type FeatureFlags = {
  websiteDiff: boolean;   // allow website_diff sources to run
  extraSections: boolean; // run the per-source strategic-synthesis sections
  aiDigest: boolean;      // generate the rolling TL;DR digest
};
```

## Extension points

Extended behavior can be injected without living in this repo. Today the LLM prompts are pluggable — ship the generic ones, or override any of them with your own tuned wording:

```ts
startTerminal({
  /* ... */
  extensions: {
    prompts: {
      buildDigestPrompt: ({ description, bulletDump }) => `...your tuned prompt...`,
      // buildFeedItemsPrompt, buildSectionsPrompt, buildWebsiteDiffPrompt also overridable
    },
  },
});
```

Anything you don't override falls back to the built-in default.

## MCP server

A separate, optional Twitter/X MCP server ships alongside the engine (`pulse-mcp` bin) exposing read/write Twitter tools over stdio. It's independent of `startTerminal`.

## License

MIT
