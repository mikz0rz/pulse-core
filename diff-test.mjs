// Live test harness for the website_diff (delta scraper) source.
//   node diff-test.mjs
// Serves a local page we control, runs the REAL website_diff cycle twice with a
// content change in between, and prints the summarized "what changed" card.
// Uses your .env LLM. Isolated: own DB/port, touches nothing on :3999.

import "dotenv/config";
import http from "http";
import fs from "fs";
import { initDb, getFeedItems } from "./build/db.js";
import { configureSummarizer } from "./build/summarizer.js";
import { configureScheduler } from "./build/scheduler.js";
import { createWebsiteDiffSource, closeWebsiteBrowser } from "./build/website-watch.js";

const DB = "./pulse.difftest.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true }); // fresh baseline each run

// ── a local "competitor pricing page" whose content we mutate ────────
let pageHtml = `<!doctype html><html><body>
  <h1>Acme AI — Pricing</h1>
  <p>Starter: $20/month, 5 seats, email support.</p>
  <p>Pro: $99/month, unlimited seats.</p>
</body></html>`;
const site = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(pageHtml);
});
await new Promise((r) => site.listen(4100, r));
console.log("[difftest] serving watched page on http://localhost:4100/");

// ── engine setup ─────────────────────────────────────────────────────
initDb(DB);
configureScheduler({ websiteDiff: true, extraSections: false, aiDigest: false }); // isolate the diff path
configureSummarizer({
  provider: process.env.LLM_PROVIDER || "openai",
  apiKey: process.env.LLM_API_KEY || "",
  baseUrl: process.env.OPENAI_BASE_URL,
  modelId: process.env.LLM_MODEL_ID || process.env.OPENAI_MODEL_ID,
});

const src = createWebsiteDiffSource({
  type: "website_diff",
  id: "acme-pricing",
  description: "Acme AI pricing page",
  url: "http://localhost:4100/",
  refreshIntervalMinutes: 999,
  enabled: true,
});

console.log("\n[difftest] CYCLE 1 — first check, establishes baseline (expect 0 cards)");
await src.runCycle();
console.log("   cards after baseline:", getFeedItems({ listId: "acme-pricing" }).length);

// ── simulate a real change on the page ───────────────────────────────
pageHtml = `<!doctype html><html><body>
  <h1>Acme AI — Pricing</h1>
  <p>Starter: $29/month, 3 seats, chat support.</p>
  <p>Pro: $149/month, unlimited seats. NEW: SSO + audit logs.</p>
  <p>Enterprise: contact sales.</p>
</body></html>`;
console.log("\n[difftest] page content changed (prices up, support downgraded, SSO + Enterprise added)");

console.log("[difftest] CYCLE 2 — second check, expect one summarized card");
await src.runCycle();

const items = getFeedItems({ listId: "acme-pricing" });
console.log("\n[difftest] cards after change:", items.length);
for (const it of items) {
  console.log("\n=== WEBSITE-DIFF CARD ===");
  console.log("headline:", it.headline);
  console.log("summary :", it.summary);
  console.log("category:", it.category ?? "(none)");
  console.log("source  :", it.sourceUrls.join(", "));
}

await closeWebsiteBrowser();
site.close();
process.exit(0);
