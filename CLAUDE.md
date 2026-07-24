# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`pulse-core` is an **open-core news-terminal engine**, not an app. It fetches from multiple source types, turns new content into structured feed items (LLM-summarized for tweets), dedupes and stores them in SQLite, and serves a password-protected live web feed (Express + Server-Sent Events + a bundled React UI). It is meant to be *composed, not forked*: a consumer writes a thin deploy repo that supplies secrets/sources and calls `startTerminal()`. See [README.md](README.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for the open-core split rationale.

## Commands

```bash
npm run build      # tsc (backend -> build/) THEN npm --prefix frontend run build (UI -> frontend/dist/)
npm run dev        # tsc --watch on the backend only

cd frontend && npm run dev     # Vite dev server; proxies /api -> http://localhost:3000 (vite.config.ts)
cd frontend && npm run build   # tsc -b && vite build -> frontend/dist/
cd frontend && npm run lint    # oxlint (the only linter in the repo)
```

There is **no test framework and no tests** in this repo — don't hunt for a test runner. There is also **no `start` script at the repo root**: the engine doesn't run itself. It's exercised either by a consuming deploy repo (see `examples/deploy-template/`, whose own `npm start` runs `node dist/main.js`) or via `examples/standalone.ts`.

## Critical conventions

- **ESM + `Node16` module resolution**: relative imports MUST carry a `.js` extension even when importing a `.ts` file (e.g. `import { startTerminal } from "./terminal.js"`). All new imports must follow this or `tsc` fails.
- **The core reads NOTHING from `process.env`.** Every secret, key, cookie, and toggle is injected through the single `startTerminal(options)` call. The lone exception is `src/mcp.ts` (a standalone `pulse-mcp` bin) which reads env directly via `dotenv` — it is independent of `startTerminal`.
- **Frontend types are hand-mirrored.** `frontend/src/api.ts` duplicates backend types (`FeedItem`, `SourceType`, `ListCheckpoint`, …) by hand — there is no shared types package. Change a wire-facing type on the backend and you must update `api.ts` too.
- **Config-injection singletons.** Most backend modules hold a module-level config set once at boot: `initDb(dbPath)`, `configureSummarizer(llm, prompts)`, `configureAuth(...)`, `configureHuggingNews(key)`, `configureScheduler(features)`. `startTerminal` (`src/terminal.ts`) wires all of them before building sources. There is no DI container — reach for these functions to inject config in tests/tools.

## Architecture

### The `Source` abstraction (the spine of the system)

Everything funnels through one interface in `src/types.ts`:

```ts
interface Source { id; type; description; refreshIntervalMinutes; runCycle(): Promise<void> }
```

The scheduler, Express routes, and frontend orchestrate sources **uniformly by this interface** — they never special-case a source id. **Adding a new source category** (a 5th `SourceType`) is exactly three edits and nothing else:
1. add a `SourceConfig` variant in `src/types.ts` (discriminated by `type`),
2. write a factory in that category's module that returns a `Source`,
3. add one `case` to the `switch` in `buildSources` (`src/sources.ts`).

The four built-in types: `twitter_list` (scheduler.ts), `media_list`/HuggingNews (huggingnews.ts), `rss_feed` + `website_diff` (website-watch.ts).

### Two cycle runners

- `runSimpleSourceCycle(id, description, fetchNewItems)` in `src/scheduler.ts` — the generic path for sources that need no LLM step and no shared browser: mark-running → fetch already-deduped items → insert → refresh digest → mark-done → SSE-emit (or mark-error). HuggingNews, RSS, and website_diff all delegate to it.
- `runListCycle(twitter, config)` — Twitter's bespoke path, because it additionally needs the browser mutex, raw-tweet dedup, LLM summarization, and auth-failure classification.

### Data flow (all source types converge)

Every source persists into the **one `feed_items` table** under its own `list_id`, so the same UI renders all types with no per-type code. Dedup differs by source: Twitter dedupes against the `raw_tweets` table; all other sources dedupe via an `external_id` UNIQUE index (`hasExternalFeedItem`). Optional per-source syntheses — the rolling TL;DR `digest` and the opt-in `extraSections` — are **regenerated in place each cycle** (upserted, never accumulated) from the trailing 24h of items, and only when a cycle produced new items.

### LLM summarization (`src/summarizer.ts`)

- Two providers: `openai` (OpenAI-compatible, incl. custom `baseUrl` gateways) and `gemini` (default). Gemini uses `responseSchema` for structured JSON; OpenAI uses `response_format: json_object`.
- **URL-hallucination guard**: the model is given tweets tagged with local ref keys (`T1`, `T2`, …) and must cite `sourceRefs`, never URLs. The server (`runListCycle`) resolves refs → real `x.com` links. `sourceRefs` is `.min(1)` in the Zod schema so an item can never land with zero source links.
- **Resilience**: one transport-level retry, then a JSON-repair retry (re-prompt with the bad output) before throwing; malformed items in an otherwise-valid batch are dropped, not fatal.
- **Prompt overrides** are the primary extension point: `extensions.prompts.build*Prompt` lets a private deploy inject tuned wording without it living in this repo. Anything not overridden falls back to the `default*Prompt` builders here.

### Browsers & concurrency

- `TwitterClient` (`src/twitter-client.ts`) holds one authenticated x.com Puppeteer page (reads via undici HTTP + X GraphQL; writes/list-scraping via the browser UI). It has **no internal locking**, so every caller MUST go through `browserMutex` (`src/browser-mutex.ts`) — this is why scheduled and manual refreshes can't race.
- `website-watch.ts` uses a **separate, unauthenticated** browser (fresh page per check, no mutex needed) so it never navigates the logged-in session to third-party domains.
- The scheduler runs **one recursive `setTimeout` loop per source** (not `setInterval`, so slow scrapes can't pile up), staggers initial kickoff by `index * 5000ms`, and clamps every interval to `MAX_REFRESH_INTERVAL_MINUTES` (24h max staleness).
- **Manual/on-open refreshes** are rate-limited to once per `MIN_MANUAL_REFRESH_MS` (15 min) per source via `getRefreshEligibility` → HTTP 429; the background scheduler bypasses this entirely. The frontend mirrors the 15-min constant (`MIN_REFRESH_MS` in `App.tsx`) only to pre-disable the button — the server is authoritative.

### Auth (`src/auth.ts`)

Single-user password login → HMAC-signed, self-verifying session cookie (**no server-side session store**), timing-safe comparison, in-memory per-IP login rate limit. `app.set("trust proxy", 1)` in `terminal.ts` is required for correct `req.ip` behind a reverse proxy (else the rate limiter collapses to one bucket).

### Feature flags

`features: { websiteDiff, extraSections, aiDigest }` gate optional capabilities per deployment. Notably `websiteDiff: false` makes `buildSources` silently drop `website_diff` sources, so variants can ship one shared source list with capabilities toggled off.

### Frontend (`frontend/`)

React 19 + Vite + TypeScript, its **own `package.json`/`node_modules`** separate from the backend. Built to `frontend/dist/`, which the backend Express process serves statically in production (resolved relative to the compiled module, not cwd, so it works when installed as a dependency). Live updates come via SSE on `/api/events`: every list state transition (cycle start/finish/failure) emits a `list-updated` event, which always refetches the tab summaries and reloads the open feed only when that list gained new items (`count > 0`). There is no separate frontend host.

### MCP server (`src/mcp.ts`)

A standalone, optional `pulse-mcp` bin exposing Twitter read/write tools over stdio (reuses `TwitterClient`). Fully independent of `startTerminal` and the only place that reads `process.env` directly.
