import "dotenv/config";
import path from "path";
import { startTerminal, loadSourceConfigs } from "pulse-core";

// A deployment is a thin wrapper: read YOUR secrets/config from the
// environment, load YOUR sources, and hand them to the engine. All the real
// work (fetching, summarizing, deduping, serving the UI) lives in pulse-core.

const sources = await loadSourceConfigs(path.resolve(process.cwd(), "sources.json"));

startTerminal({
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), "data.db"),

  // Secrets — you supply these; the engine never reads env itself.
  appPassword: process.env.APP_PASSWORD || "",
  sessionSecret: process.env.SESSION_SECRET || "",
  secureCookie: process.env.NODE_ENV === "production",

  llm: {
    provider: (process.env.LLM_PROVIDER as "openai" | "gemini") || "gemini",
    apiKey: process.env.LLM_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL, // OpenAI-compatible gateways only
    modelId: process.env.LLM_MODEL_ID,
  },
  twitter: {
    authToken: process.env.TWITTER_AUTH_TOKEN || "",
    ct0: process.env.TWITTER_CT0 || "",
  },
  huggingNewsApiKey: process.env.HUGGINGNEWS_API_KEY, // optional

  sources,

  // Turn capabilities on/off for this deployment.
  features: {
    websiteDiff: true,
    extraSections: false,
    aiDigest: true,
  },

  branding: { title: process.env.SITE_TITLE || "News Terminal" },

  // Optional: inject your own tuned prompts without changing the core.
  // extensions: { prompts: { buildDigestPrompt: ({ description, bulletDump }) => `...` } },
});
