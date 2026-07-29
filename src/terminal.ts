import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { TwitterClient } from "./twitter-client.js";
import { buildSources } from "./sources.js";
import { startScheduler, schedulerEvents, configureScheduler, getRefreshEligibility } from "./scheduler.js";
import {
  initDb,
  getFeedItems,
  getAllCheckpoints,
  getDigest,
  getSections,
} from "./db.js";
import { loginHandler, logoutHandler, sessionStatusHandler, requireAuth, configureAuth } from "./auth.js";
import { configureSummarizer } from "./summarizer.js";
import { configureHuggingNews } from "./huggingnews.js";
import { configureStaleness } from "./staleness.js";
import { closeWebsiteBrowser } from "./website-watch.js";
import type { Source } from "./types.js";
import type { StartTerminalOptions } from "./terminal-config.js";

// The built frontend ships inside this package (frontend/dist), resolved
// relative to the compiled module — NOT the consumer's cwd — so it works when
// pulse-core is installed as a dependency in another repo.
const FRONTEND_DIST = fileURLToPath(new URL("../frontend/dist", import.meta.url));

/**
 * Boots the whole news-terminal engine: persistence, scheduler, and the
 * password-protected web feed. Every secret and toggle is passed in via
 * `options`; the core reads nothing from the environment itself.
 */
export function startTerminal(options: StartTerminalOptions): void {
  initDb(options.dbPath);
  configureSummarizer(options.llm, options.extensions?.prompts);
  configureAuth({
    appPassword: options.appPassword,
    sessionSecret: options.sessionSecret,
    secureCookie: options.secureCookie ?? false,
  });
  configureHuggingNews(options.huggingNewsApiKey);
  configureStaleness(options.stalenessThresholdHours);
  configureScheduler(options.features);

  const twitter = new TwitterClient(options.twitter.authToken, options.twitter.ct0);
  const sources: Source[] = buildSources(twitter, options.sources, options.features);
  if (sources.length === 0) {
    console.warn("[terminal] No sources configured.");
  }

  const app = express();
  // Behind a reverse proxy — without this req.ip is the proxy's address for
  // every request, collapsing auth.ts's per-IP login rate limit into one bucket.
  app.set("trust proxy", 1);
  app.use(express.json());

  app.post("/api/login", loginHandler);
  app.post("/api/logout", logoutHandler);
  app.get("/api/session", sessionStatusHandler);

  // Public (pre-auth) branding so the login screen can render the variant's
  // title/theme. Contains no secrets.
  app.get("/api/config", (_req, res) => {
    res.json({ branding: options.branding });
  });

  app.get("/api/lists", requireAuth, (_req, res) => {
    const checkpoints = new Map(getAllCheckpoints().map((c) => [c.listId, c]));
    res.json(
      sources.map((s) => ({
        id: s.id,
        type: s.type,
        description: s.description,
        refreshIntervalMinutes: s.refreshIntervalMinutes,
        // The client derives "is it stale?" itself from this threshold plus
        // the checkpoint's lastItemAt/watchingSince, the same way it derives
        // the refresh backoff — so it can re-evaluate on its own clock tick
        // as a source crosses the threshold between server events.
        stalenessThresholdHours: s.stalenessThresholdHours,
        checkpoint: checkpoints.get(s.id) ?? null,
      }))
    );
  });

  app.get("/api/feed", requireAuth, (req, res) => {
    const { listId, since, limit } = req.query;
    const items = getFeedItems({
      listId: typeof listId === "string" ? listId : undefined,
      since: typeof since === "string" ? since : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json({ items });
  });

  app.get("/api/digest", requireAuth, (req, res) => {
    const { listId } = req.query;
    if (typeof listId !== "string") {
      res.status(400).json({ error: "listId is required" });
      return;
    }
    res.json(getDigest(listId) ?? null);
  });

  app.get("/api/sections", requireAuth, (req, res) => {
    const { listId } = req.query;
    if (typeof listId !== "string") {
      res.status(400).json({ error: "listId is required" });
      return;
    }
    res.json(getSections(listId));
  });

  app.post("/api/lists/:id/refresh", requireAuth, (req, res) => {
    const source = sources.find((s) => s.id === req.params.id);
    if (!source) {
      res.status(404).json({ error: "Unknown list id" });
      return;
    }

    // Rate-limit user/on-open triggered refreshes to at most once per 15 min
    // per source (the background scheduler is unaffected). The UI reads this
    // 429 to show a backoff tooltip.
    const eligibility = getRefreshEligibility(source.id);
    if (!eligibility.allowed) {
      res.status(429).json({
        error: eligibility.reason === "running" ? "A refresh is already running" : "Refreshed recently",
        reason: eligibility.reason,
        retryAfterMs: eligibility.retryAfterMs,
        nextAllowedAt: eligibility.nextAllowedAt,
      });
      return;
    }

    res.status(202).json({ ok: true });
    source.runCycle().catch((err) => {
      console.error(`[terminal] Manual refresh failed for ${source.id}:`, err);
    });
  });

  app.get("/api/events", requireAuth, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");

    const onListUpdate = (payload: unknown) => {
      res.write(`event: list-updated\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    schedulerEvents.on("list-updated", onListUpdate);

    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);

    req.on("close", () => {
      clearInterval(heartbeat);
      schedulerEvents.off("list-updated", onListUpdate);
    });
  });

  app.use(express.static(FRONTEND_DIST));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });

  app.listen(options.port, () => {
    console.log(`[terminal] "${options.branding.title}" listening on port ${options.port}`);
  });

  startScheduler(sources);

  const shutdown = async (signal: string) => {
    console.log(`[terminal] Received ${signal}, shutting down...`);
    await twitter.close();
    await closeWebsiteBrowser();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
