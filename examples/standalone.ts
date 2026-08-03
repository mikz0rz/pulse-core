// Minimal standalone example. A stranger can copy this, supply their own
// keys/cookies via the environment, and run a single-variant terminal.
//
//   npm install && npm run build
//   TWITTER_AUTH_TOKEN=... TWITTER_CT0=... GEMINI_API_KEY=... \
//     APP_PASSWORD=<strong-min-8-char-password> SESSION_SECRET=$(openssl rand -hex 32) \
//     node build/examples/standalone.js
//
// (This file lives in the public repo only as documentation — the engine
// itself reads none of these env vars; this wrapper does, then injects them.)

// Illustrative: in a consuming project you would import from the package.
import { startTerminal, type SourceConfig } from "pulse-core";

const sources: SourceConfig[] = [
  {
    type: "rss_feed",
    id: "example-blog",
    description: "Example Blog",
    feedUrl: "https://stackoverflow.blog/feed/",
    refreshIntervalMinutes: 60,
    enabled: true,
  },
];

const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!APP_PASSWORD) {
  throw new Error("APP_PASSWORD environment variable is required");
}
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}

startTerminal({
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || "./pulse.db",
  appPassword: APP_PASSWORD,
  sessionSecret: SESSION_SECRET,
  secureCookie: process.env.NODE_ENV === "production",
  llm: {
    provider: (process.env.LLM_PROVIDER as "openai" | "gemini") || "gemini",
    apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL,
    modelId: process.env.LLM_MODEL_ID,
  },
  twitter: {
    authToken: process.env.TWITTER_AUTH_TOKEN || "",
    ct0: process.env.TWITTER_CT0 || "",
  },
  sources,
  features: { websiteDiff: true, extraSections: false, aiDigest: true },
  branding: { title: "News Terminal" },
});
