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

There is **no test framework** — don't hunt for a test runner. `npm test` runs `tsc` then Node's built-in `node:test` over `test/*.test.mjs`, which import the *compiled* `build/` output. Test files live outside `src/` so they're never compiled into the published `build/`. Coverage is deliberately narrow: the pure decision functions that are hard to get right and easy to test without a database or a network — `nextCycleDelayMs` and `planDigest` (`test/scheduler.test.mjs`) and `isRetryableLlmError` (`test/summarizer.test.mjs`). **Follow that precedent**: when a change adds subtle arithmetic or a subtle predicate, extract it into a pure, total, exported function and unit-test it there rather than adding an integration harness.

There is also **no `start` script at the repo root**: the engine doesn't run itself. It's exercised either by a consuming deploy repo (see `examples/deploy-template/`, whose own `npm start` runs `node dist/main.js`) or via `examples/standalone.ts`.

## Critical conventions

- **ESM + `Node16` module resolution**: relative imports MUST carry a `.js` extension even when importing a `.ts` file (e.g. `import { startTerminal } from "./terminal.js"`). All new imports must follow this or `tsc` fails.
- **The core reads NOTHING from `process.env`.** Every secret, key, cookie, and toggle is injected through the single `startTerminal(options)` call. The lone exception is `src/mcp.ts` (a standalone `pulse-mcp` bin) which reads env directly via `dotenv` — it is independent of `startTerminal`.
- **Frontend types are hand-mirrored.** `frontend/src/api.ts` duplicates backend types (`FeedItem`, `SourceType`, `ListCheckpoint`, …) by hand — there is no shared types package. Change a wire-facing type on the backend and you must update `api.ts` too. Same applies to the one piece of mirrored *logic*: `frontend/src/staleness.ts` reimplements `src/staleness.ts`'s verdict.
- **Config-injection singletons.** Most backend modules hold a module-level config set once at boot: `initDb(dbPath)`, `configureSummarizer(llm, prompts)`, `configureAuth(...)`, `configureHuggingNews(key)`, `configureStaleness(hours)`, `configureScheduler(features)`. `startTerminal` (`src/terminal.ts`) wires all of them before building sources. There is no DI container — reach for these functions to inject config in tests/tools.

## Architecture

### The `Source` abstraction (the spine of the system)

Everything funnels through one interface in `src/types.ts`:

```ts
interface Source { id; type; description; refreshIntervalMinutes; stalenessThresholdHours; runCycle(): Promise<void> }
```

The scheduler, Express routes, and frontend orchestrate sources **uniformly by this interface** — they never special-case a source id. **Adding a new source category** (a 5th `SourceType`) is exactly three edits and nothing else:
1. add a `SourceConfig` variant in `src/types.ts` (discriminated by `type`),
2. write a factory in that category's module that returns a `Source`,
3. add one `case` to the `switch` in `buildSources` (`src/sources.ts`).

The four built-in types: `twitter_list` (scheduler.ts), `media_list`/HuggingNews (huggingnews.ts), `rss_feed` + `website_diff` (website-watch.ts).

A `Source` also carries a resolved `stalenessThresholdHours` (see **Staleness** below), so a new category's factory must set it — `resolveStalenessThresholdHours(config)` does that from the config.

### Two cycle runners

- `runSimpleSourceCycle(id, description, fetchNewItems)` in `src/scheduler.ts` — the generic path for sources that need no LLM step and no shared browser: mark-running → fetch already-deduped items → insert → refresh digest → mark-done → SSE-emit (or mark-error). HuggingNews, RSS, and website_diff all delegate to it.
- `runListCycle(twitter, config)` — Twitter's bespoke path, because it additionally needs the browser mutex, raw-tweet dedup, LLM summarization, and auth-failure classification.

### Data flow (all source types converge)

Every source persists into the **one `feed_items` table** under its own `list_id`, so the same UI renders all types with no per-type code. Dedup differs by source: Twitter dedupes against the `raw_tweets` table; all other sources dedupe via an `external_id` UNIQUE index (`hasExternalFeedItem`). Optional per-source syntheses — the rolling TL;DR `digest` and the opt-in `extraSections` — are **regenerated in place each cycle** (upserted, never accumulated), and only when a cycle produced new items. Both are derived from the trailing 24h of items, but the digest sends only the newly inserted stories on most cycles (see *The rolling digest* below); `extraSections` still sends the full 24h every time.

### Staleness / silent-failure detection (`src/staleness.ts`)

A cycle that fetches fine but yields **zero** items is stored as `last_fetch_status = "ok"` — indistinguishable from a healthy quiet source, which is how a broken scrape hides behind a green dot and a recent "Updated 2m ago" (the failure mode behind the `user.legacy` regression). So `list_checkpoints` also tracks **`last_item_at`** (last *productive* cycle — only advanced when `markFetchDone` is passed a non-zero `newItemCount`) and **`watching_since`** (write-once first cycle, the baseline before a source has ever produced anything). Past the threshold with neither advancing, the source is stale.

- **Thresholds**: default 12h, injected via `startTerminal({ stalenessThresholdHours })`. On by default only for `twitter_list`/`media_list`, where a dry spell means breakage; **off** for `rss_feed`/`website_diff`, where silence is the normal steady state. Per-source `stalenessThresholdHours` overrides either way (`0` silences, positive opts in).
- **Suppressed** for sources whose last cycle actually errored — that already surfaces its own error, and a second alert would double-report one breakage. *Not* suppressed while `running`, or the alert would flicker every cycle.
- **Surfaced twice**: `console.warn` from the scheduler's post-cycle hook (so a dead source is visible in logs without the UI open), and in the UI as a dismissible error snack (`components/SnackBar.tsx`), a hollow tab dot, and the toolbar status line.
- The server sends only the raw inputs (threshold + the two timestamps) on `/api/lists`; the verdict is computed client-side in `frontend/src/staleness.ts` — a hand-mirror of the backend module — so the existing minute tick catches a source crossing its threshold without waiting for a server event. Snack dismissal is keyed to the *specific* dry spell (its start timestamp), so a source that recovers and breaks again re-alerts.

### LLM summarization (`src/summarizer.ts`)

- Two providers: `openai` (OpenAI-compatible, incl. custom `baseUrl` gateways) and `gemini` (default). Gemini uses `responseSchema` for structured JSON; OpenAI uses `response_format: json_object`.
- **URL-hallucination guard**: the model is given tweets tagged with local ref keys (`T1`, `T2`, …) and must cite `sourceRefs`, never URLs. The server (`runListCycle`) resolves refs → real `x.com` links. `sourceRefs` is `.min(1)` in the Zod schema so an item can never land with zero source links.
- **Resilience**: one transport-level retry, then a JSON-repair retry (re-prompt with the bad output) before throwing; malformed items in an otherwise-valid batch are dropped, not fatal. The transport retry is **narrow on purpose** — `isRetryableLlmError` (pure, exported, tested) retries only 408, 5xx except 501, `TimeoutError`, and undici's `TypeError("fetch failed")`. 4xx including **429** is not retried: the retry was immediate, so it burned quota again at the exact moment quota was the problem, and the next scheduled cycle is the natural backoff. Failures are thrown as `LlmHttpError`, whose `"<Provider> API error: <status>"` message prefix is load-bearing — `sanitizeErrorForClient` in `scheduler.ts` matches it to keep LLM response bodies out of the UI. The two call sites that lose data on failure (`runListCycle` inserts raw tweets before summarizing; `checkDiffSite` advances the snapshot before diffing) keep the transport retry on their JSON-repair call; digest and sections self-heal next cycle and so use a plain `callProvider` there.
- **Prompt overrides** are the primary extension point: `extensions.prompts.build*Prompt` lets a private deploy inject tuned wording without it living in this repo. Anything not overridden falls back to the `default*Prompt` builders here.

### The rolling digest (`refreshDigest` in `src/scheduler.ts`)

The largest single prompt in the system, so it has its own cost control. `planDigest` (pure, exported, tested — same precedent as `nextCycleDelayMs`) picks one of three modes per cycle, first matching rule winning: empty window → skip; incremental off → full; no previous digest → full; untrustworthy timestamps → full (spend more, stay correct); rebuild overdue → full, checked **before** the no-new-items skip, since a rebuild exists to drop aged-out bullets and is worth doing even when the triggering cycle added nothing; nothing new → skip; new items ≥ 50% of the window → full; otherwise → incremental. It never throws — it runs on the reschedule path, where an escaped error is far worse than an over-eager rebuild.

Four traps the implementation exists to avoid:

- **The cursor is a pre-read snapshot.** `refreshDigest` takes `Date.now()` *before* the DB read with no `await` in between. Stamping it after the LLM call would skip anything inserted during that call — potentially 90s+ — permanently.
- **The split is on insert time (`createdAt`), not post time (`itemTimestamp`).** A tweet posted 6h ago but first scraped now is genuinely new to the digest; splitting on post time would drop it and the digest would never see it. Ties count as new — seeing a story twice is harmless, missing one is not.
- **Drift needs its own marker.** Incremental rewrites accumulate error because the model can't tell that a bullet's story has aged out of the window. Bounding it needs the last *full* rebuild time, which cannot be `generated_at`: on a busy source the digest is rewritten every cycle, so "rebuild when the stored digest is older than 12h" would never fire. Hence the separate nullable `list_digests.full_rebuild_at`, advanced only on a full rebuild and carried across incremental writes by `COALESCE` in the upsert. That upsert also carries `WHERE excluded.generated_at >= list_digests.generated_at`, because the background loop never checks the checkpoint and a manual refresh can overlap a timer tick — a stale snapshot must not overwrite a newer one (ISO strings compare correctly).
- **`itemCount` is always the 24h window size**, never the incremental batch — `TldrSection.tsx` renders it as the user-visible `past 24 hours · N stories`.

`DigestState` (bullets + cursor + rebuild marker) is deliberately **not** part of the public `ListDigest`, which goes straight onto the wire; the scheduler reads the marker through the separate `getDigestState`. That keeps `full_rebuild_at` off the API and out of the hand-mirrored `frontend/src/api.ts`. `generatedAt` on the wire is the snapshot time, which can precede the actual write by the length of the LLM call; nothing renders it.

Bullets can therefore describe a story up to ~36h old (24h window + 12h rebuild + one cycle) under a "past 24 hours" label. `DIGEST_FULL_REBUILD_MS` is the knob that bounds that.

### Browsers & concurrency

- `TwitterClient` (`src/twitter-client.ts`) holds one authenticated x.com Puppeteer page (reads via undici HTTP + X GraphQL; writes/list-scraping via the browser UI). It has **no internal locking**, so every caller MUST go through `browserMutex` (`src/browser-mutex.ts`) — this is why scheduled and manual refreshes can't race.
- `website-watch.ts` uses a **separate, unauthenticated** browser (fresh page per check, no mutex needed) so it never navigates the logged-in session to third-party domains.
- The scheduler runs **one recursive `setTimeout` loop per source** (not `setInterval`, so slow scrapes can't pile up), staggers initial kickoff by `index * 5000ms`, and clamps every interval to `MAX_REFRESH_INTERVAL_MINUTES` (24h max staleness).
- **Working hours** (`WorkingHoursConfig`, injected as `startTerminal({ workingHours })`): each source keeps its own `refreshIntervalMinutes` inside the configured local-time window and drops to `quietIntervalMinutes` outside it, so overnight cycles aren't spent on a feed nobody reads. The window **only ever slows a source down** — a source already slower than the quiet interval keeps its own cadence. The delay is recomputed by the pure `nextCycleDelayMs` at *every* reschedule (not fixed at startup) so loops cross the boundaries on their own, and it never throws: it runs inside a `.then()` with no rejection handler, so a throw there would be an unhandled rejection and kill the process. Two constraints on any policy: keep `quietIntervalMinutes` under `stalenessThresholdHours` (or quiet sources alert as stale) and under each Twitter list's `hoursWindow` (or tweets fall out of the scrape window between cycles and are lost). `timeZone` must be explicit — containers normally run UTC.
- **Manual/on-open refreshes** are rate-limited to once per `MIN_MANUAL_REFRESH_MS` (15 min) per source via `getRefreshEligibility` → HTTP 429; the background scheduler bypasses this entirely. The frontend mirrors the 15-min constant (`MIN_REFRESH_MS` in `App.tsx`) only to pre-disable the button — the server is authoritative.

### Auth (`src/auth.ts`)

Single-user password login → HMAC-signed, self-verifying session cookie (**no server-side session store**), timing-safe comparison, in-memory per-IP login rate limit. `app.set("trust proxy", 1)` in `terminal.ts` is required for correct `req.ip` behind a reverse proxy (else the rate limiter collapses to one bucket).

### Feature flags

`features: { websiteDiff, extraSections, aiDigest, incrementalDigest? }` gate optional capabilities per deployment. Notably `websiteDiff: false` makes `buildSources` silently drop `website_diff` sources, so variants can ship one shared source list with capabilities toggled off.

`incrementalDigest` is optional and **resolved in `terminal.ts`, not at the call site**, so no consumer has to know the rule: `options.features.incrementalDigest ?? !options.extensions?.prompts?.buildDigestPrompt`. An overridden `buildDigestPrompt` was written against the old single-mode argument list and can't fold in `previousBullets`, so incremental mode would silently reduce the digest to only the newest stories — defaulting it off there makes that impossible, and doubles as a kill switch. An explicit value always wins.

### Frontend (`frontend/`)

React 19 + Vite + TypeScript, its **own `package.json`/`node_modules`** separate from the backend. Built to `frontend/dist/`, which the backend Express process serves statically in production (resolved relative to the compiled module, not cwd, so it works when installed as a dependency). Live updates come via SSE on `/api/events`: every list state transition (cycle start/finish/failure) emits a `list-updated` event, which always refetches the tab summaries and reloads the open feed only when that list gained new items (`count > 0`). There is no separate frontend host.

### MCP server (`src/mcp.ts`)

A standalone, optional `pulse-mcp` bin exposing Twitter read/write tools over stdio (reuses `TwitterClient`). Fully independent of `startTerminal` and the only place that reads `process.env` directly.
