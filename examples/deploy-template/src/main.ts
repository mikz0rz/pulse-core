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

  // Optional (default 12): hours a source may go without producing a single
  // item before the UI raises it as a stale-source alert. Catches the silent
  // failure where fetches keep succeeding but return nothing. Override per
  // source with `stalenessThresholdHours` in sources.json (0 to silence one).
  // stalenessThresholdHours: 12,

  // Optional: refresh fast through the working day and slowly outside it, so
  // overnight cycles (and their LLM calls) aren't spent on a feed nobody is
  // reading. Each source keeps its own `refreshIntervalMinutes` inside the
  // window and drops to `quietIntervalMinutes` outside it — the window only
  // ever SLOWS a source down, never speeds one up, so a page you poll every 3h
  // stays at 3h. `timeZone` is required and must be an IANA zone: containers
  // usually run UTC, so leaving it implicit would put the window in the wrong
  // hours. Keep `quietIntervalMinutes` under both `stalenessThresholdHours`
  // and any Twitter list's `hoursWindow`, or you'll get stale-source alerts
  // and miss tweets that fall out of the scrape window between cycles.
  // workingHours: {
  //   timeZone: "Europe/Vilnius",
  //   startHour: 9,
  //   endHour: 18,          // exclusive
  //   days: [1, 2, 3, 4, 5], // 1=Mon … 7=Sun; defaults to Mon-Fri
  //   quietIntervalMinutes: 240,
  // },

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
