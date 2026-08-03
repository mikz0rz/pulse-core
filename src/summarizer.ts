import { z } from "zod";
import type { Tweet, TwitterListSourceConfig, FeedItemDraft, FeedItem, ExtraSection } from "./types.js";
import type { LlmConfig, PromptOverrides } from "./terminal-config.js";

// ─── Injected config (set once by startTerminal, never read from env) ────
let llmConfig: LlmConfig = { provider: "gemini", apiKey: "" };
let promptOverrides: PromptOverrides = {};

export function configureSummarizer(llm: LlmConfig, prompts?: PromptOverrides): void {
  llmConfig = llm;
  promptOverrides = prompts ?? {};
}

// sourceRefs must cite at least one ref, or the URL-hallucination guard in
// scheduler.ts would silently produce a card with zero source links.
const FeedItemDraftSchema = z.object({
  type: z.literal("tweet_update"),
  brand: z.string().optional(),
  headline: z.string(),
  summary: z.string(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sourceRefs: z.array(z.string()).min(1),
});

const RawItemsResponseSchema = z.object({ items: z.array(z.unknown()) });

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["tweet_update"] },
          brand: { type: "STRING" },
          headline: { type: "STRING" },
          summary: { type: "STRING" },
          category: { type: "STRING" },
          tags: { type: "ARRAY", items: { type: "STRING" } },
          sourceRefs: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["type", "headline", "summary", "sourceRefs"],
      },
    },
  },
  required: ["items"],
};

const DigestResponseSchema = z.object({ bullets: z.array(z.string()) });

const WebsiteDiffResponseSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  category: z.string().optional(),
});

const GEMINI_WEBSITE_DIFF_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    summary: { type: "STRING" },
    category: { type: "STRING" },
  },
  required: ["headline", "summary"],
};

const GEMINI_DIGEST_SCHEMA = {
  type: "OBJECT",
  properties: {
    bullets: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["bullets"],
};

const SectionsResponseSchema = z.object({
  sections: z.array(z.object({ title: z.string(), content: z.string() })),
});

const GEMINI_SECTIONS_SCHEMA = {
  type: "OBJECT",
  properties: {
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          content: { type: "STRING" },
        },
        required: ["title", "content"],
      },
    },
  },
  required: ["sections"],
};

/** Assigns each tweet a short local ref key so the LLM never has to (mis)quote a URL itself. */
export function buildTweetDump(tweets: Tweet[]): { dumpText: string; refMap: Map<string, Tweet> } {
  const refMap = new Map<string, Tweet>();
  const lines = tweets.map((t, i) => {
    const ref = `T${i + 1}`;
    refMap.set(ref, t);
    return `[${ref}] @${t.author.username ?? "unknown"} (${t.created_at})\n${t.text}`;
  });
  return { dumpText: lines.join("\n\n---\n\n"), refMap };
}

function buildCategoryInstruction(existingCategories: string[]): string {
  return existingCategories.length > 0
    ? `Categories already used for this list: ${existingCategories.join(", ")}. Reuse one of these exactly (same spelling/casing) if it fits. Only invent a new category if none of these fit, and if you do, keep it short, Title Case, and avoid creating a near-duplicate of an existing one (e.g. don't invent "Product Updates" if "Product Update" is already in the list above).`
    : `Keep "category" short and Title Case (e.g. "Product Launch", "Research").`;
}

// ─── Default (generic) prompt builders. A consumer can override any of these
// via TerminalExtensions.prompts without the override living in the core. ──

function defaultFeedItemsPrompt(args: { dumpText: string; promptContext?: string; existingCategories: string[] }): string {
  return `You are analyzing tweets from a Twitter list. ${args.promptContext ?? ""}

Reply with ONLY a JSON object of the form { "items": FeedItem[] }, no prose or markdown fences. Each FeedItem looks like:
{
  "type": "tweet_update",
  "brand": "the specific brand, product, or company this update is about",
  "headline": "a short, specific headline",
  "summary": "1-3 sentences of detail",
  "category": "optional short category label",
  "tags": ["optional", "keywords"],
  "sourceRefs": ["T3", "T7"]
}

Rules:
- One item per distinct piece of news or update. Merge duplicate/related tweets about the same update into a single item, listing every relevant ref key in sourceRefs.
- Always name the specific brand or product so it's clear who/what an item is about without following a link.
- sourceRefs must only contain ref keys ("T1", "T2", ...) copied exactly from the tweet dump below — never invent a URL or a ref key that isn't present.
- Ignore spam, generic engagement-bait, and irrelevant chatter.
- ${buildCategoryInstruction(args.existingCategories)}

Tweets:
${args.dumpText}`;
}

function defaultDigestPrompt(args: { description: string; bulletDump: string }): string {
  return `Here are the most recent headlines from "${args.description}" over roughly the past day:

${args.bulletDump}

Identify the 3-6 MOST IMPORTANT, distinct developments or themes across these headlines. Merge related items that share a theme into a single bullet. Each bullet must be ONE short, information-dense sentence (not a paragraph), naming the specific brand/product involved.

Reply with ONLY a JSON object of the form { "bullets": ["...", "...", ...] }, no prose, no markdown fences.`;
}

function defaultSectionsPrompt(args: { description: string; bulletDump: string; sections: ExtraSection[] }): string {
  const sectionDefs = args.sections.map((s) => `- "${s.title}": ${s.instruction}`).join("\n");
  return `Here are the most recent headlines from "${args.description}" over roughly the past day:

${args.bulletDump}

Write content for each of the following sections, based on the headlines above:
${sectionDefs}

Each section's content should be a few sentences to a short paragraph, specific and actionable rather than generic.

Reply with ONLY a JSON object of the form { "sections": [{ "title": "...", "content": "..." }, ...] }, one entry per section listed above (using the exact title text given), no prose, no markdown fences.`;
}

function defaultWebsiteDiffPrompt(args: { description: string; url: string; diffText: string; existingCategories: string[] }): string {
  return `The following is a line-level diff of content changes detected on "${args.description}"'s page at ${args.url}. Lines starting with "+" were added, lines starting with "-" were removed.

${args.diffText}

Write one short, specific headline and a 1-3 sentence summary of what changed and what it might signal about their strategy or direction (e.g. pricing changes, new positioning, feature launches, messaging shifts). Optionally include a short category label. ${buildCategoryInstruction(args.existingCategories)}

Reply with ONLY a JSON object of the form { "headline": "...", "summary": "...", "category": "..." }, no prose, no markdown fences.`;
}

// A batch's LLM call is one big synchronous round trip with no partial
// progress — if the connection stalls, fail fast instead of hanging.
const LLM_TIMEOUT_MS = 90_000;

async function callOpenAI(prompt: string, geminiSchema: object | null): Promise<string> {
  const baseUrl = llmConfig.baseUrl || "https://api.openai.com/v1";
  const apiKey = llmConfig.apiKey;
  const modelId = llmConfig.modelId || "gpt-4o";
  const fullUrl = baseUrl.includes("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  const jsonMode = geminiSchema !== null;

  const response = await fetch(fullUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        {
          role: "system",
          content: jsonMode
            ? "You are a precise assistant that extracts structured updates from tweets and replies with strict JSON only."
            : "You are a precise assistant that writes short, information-dense news summaries.",
        },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as any;
  return data.choices?.[0]?.message?.content || "{}";
}

async function callGemini(prompt: string, geminiSchema: object | null): Promise<string> {
  const apiKey = llmConfig.apiKey;
  const modelId = llmConfig.modelId || "gemini-3.1-pro-preview";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: geminiSchema
          ? { responseMimeType: "application/json", responseSchema: geminiSchema }
          : {},
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

async function callProvider(prompt: string, geminiSchema: object | null): Promise<string> {
  return llmConfig.provider === "openai" ? callOpenAI(prompt, geminiSchema) : callGemini(prompt, geminiSchema);
}

/** One retry on transport-level failure (timeout, connection reset) — distinct from the JSON-repair retry below. */
async function callProviderWithRetry(prompt: string, geminiSchema: object | null): Promise<string> {
  try {
    return await callProvider(prompt, geminiSchema);
  } catch (error) {
    console.warn(`[summarizer] LLM call failed (${(error as Error).message}), retrying once...`);
    return callProvider(prompt, geminiSchema);
  }
}

function tryParse(raw: string): FeedItemDraft[] | null {
  let json: unknown;
  try {
    const stripped = raw
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    json = JSON.parse(stripped);
  } catch {
    return null;
  }

  const outer = RawItemsResponseSchema.safeParse(json);
  if (!outer.success) return null;

  const valid: FeedItemDraft[] = [];
  let dropped = 0;
  for (const item of outer.data.items) {
    const result = FeedItemDraftSchema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    console.warn(`[summarizer] Dropped ${dropped} malformed feed item(s) from LLM output.`);
  }
  return valid.length > 0 || outer.data.items.length === 0 ? valid : null;
}

/**
 * Calls the configured LLM to turn a tweet dump into structured feed items.
 * On invalid/unparseable output, retries once with a repair prompt before giving up.
 */
export async function generateFeedItems(
  dumpText: string,
  config: TwitterListSourceConfig,
  existingCategories: string[] = []
): Promise<FeedItemDraft[]> {
  const build = promptOverrides.buildFeedItemsPrompt ?? defaultFeedItemsPrompt;
  const prompt = build({ dumpText, promptContext: config.promptContext, existingCategories });

  let raw = await callProviderWithRetry(prompt, GEMINI_RESPONSE_SCHEMA);
  let parsed = tryParse(raw);

  if (!parsed) {
    const repairPrompt = `Your previous response was not valid JSON matching the required schema. Reply with ONLY a valid JSON object of the form { "items": [...] }, no prose, no markdown fences. Every "tweet_update" item MUST include a non-empty "sourceRefs" array.\n\nYour previous response was:\n${raw}`;
    raw = await callProviderWithRetry(repairPrompt, GEMINI_RESPONSE_SCHEMA);
    parsed = tryParse(raw);
  }

  if (!parsed) {
    throw new Error(`LLM did not return valid structured output after retry. Last response: ${raw.slice(0, 500)}`);
  }

  return parsed;
}

function tryParseDigest(raw: string): string[] | null {
  try {
    const stripped = raw
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = DigestResponseSchema.parse(JSON.parse(stripped));
    return parsed.bullets.map((b) => b.trim()).filter((b) => b.length > 0);
  } catch {
    return null;
  }
}

/**
 * Synthesizes a handful of short, scannable highlight bullets across a
 * source's recent feed items (already-summarized headlines, not raw tweets).
 */
export async function generateDigest(items: FeedItem[], source: { description: string }): Promise<string[]> {
  if (items.length === 0) return [];

  const bulletDump = items
    .map((item) => `- ${item.brand ? `[${item.brand}] ` : ""}${item.headline}: ${item.summary}`)
    .join("\n");

  const build = promptOverrides.buildDigestPrompt ?? defaultDigestPrompt;
  const prompt = build({ description: source.description, bulletDump });

  let raw = await callProviderWithRetry(prompt, GEMINI_DIGEST_SCHEMA);
  let bullets = tryParseDigest(raw);

  if (!bullets) {
    const repairPrompt = `Your previous response was not valid JSON. Reply with ONLY a JSON object of the form { "bullets": ["...", ...] }, no prose, no markdown fences.\n\nYour previous response was:\n${raw}`;
    raw = await callProviderWithRetry(repairPrompt, GEMINI_DIGEST_SCHEMA);
    bullets = tryParseDigest(raw);
  }

  return bullets ?? [];
}

interface GeneratedSection {
  title: string;
  content: string;
}

function tryParseSections(raw: string): GeneratedSection[] | null {
  try {
    const stripped = raw
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = SectionsResponseSchema.parse(JSON.parse(stripped));
    return parsed.sections.map((s) => ({ title: s.title.trim(), content: s.content.trim() }));
  } catch {
    return null;
  }
}

/**
 * Synthesizes content for a source's configured extraSections from its recent
 * feed items. Returns one entry per requested section; the caller replaces
 * that section's stored row rather than accumulating a new one each cycle.
 */
export async function generateSections(
  items: FeedItem[],
  source: { description: string },
  sections: ExtraSection[]
): Promise<GeneratedSection[]> {
  if (items.length === 0 || sections.length === 0) return [];

  const bulletDump = items
    .map((item) => `- ${item.brand ? `[${item.brand}] ` : ""}${item.headline}: ${item.summary}`)
    .join("\n");

  const build = promptOverrides.buildSectionsPrompt ?? defaultSectionsPrompt;
  const prompt = build({ description: source.description, bulletDump, sections });

  let raw = await callProviderWithRetry(prompt, GEMINI_SECTIONS_SCHEMA);
  let parsed = tryParseSections(raw);

  if (!parsed) {
    const repairPrompt = `Your previous response was not valid JSON. Reply with ONLY a JSON object of the form { "sections": [{ "title": "...", "content": "..." }, ...] }, no prose, no markdown fences.\n\nYour previous response was:\n${raw}`;
    raw = await callProviderWithRetry(repairPrompt, GEMINI_SECTIONS_SCHEMA);
    parsed = tryParseSections(raw);
  }

  return parsed ?? [];
}

interface WebsiteDiffSummary {
  headline: string;
  summary: string;
  category?: string;
}

function tryParseWebsiteDiff(raw: string): WebsiteDiffSummary | null {
  try {
    const stripped = raw
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = WebsiteDiffResponseSchema.parse(JSON.parse(stripped));
    return {
      headline: parsed.headline.trim(),
      summary: parsed.summary.trim(),
      category: parsed.category?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

/** Turns a line-level content diff of a watched page into one readable feed item. */
export async function summarizeWebsiteDiff(
  description: string,
  url: string,
  diffText: string,
  existingCategories: string[] = []
): Promise<WebsiteDiffSummary> {
  const build = promptOverrides.buildWebsiteDiffPrompt ?? defaultWebsiteDiffPrompt;
  const prompt = build({ description, url, diffText, existingCategories });

  let raw = await callProviderWithRetry(prompt, GEMINI_WEBSITE_DIFF_SCHEMA);
  let parsed = tryParseWebsiteDiff(raw);

  if (!parsed) {
    const repairPrompt = `Your previous response was not valid JSON. Reply with ONLY a JSON object of the form { "headline": "...", "summary": "...", "category": "..." }, no prose, no markdown fences.\n\nYour previous response was:\n${raw}`;
    raw = await callProviderWithRetry(repairPrompt, GEMINI_WEBSITE_DIFF_SCHEMA);
    parsed = tryParseWebsiteDiff(raw);
  }

  if (!parsed) {
    throw new Error(`LLM did not return valid structured output for website diff. Last response: ${raw.slice(0, 500)}`);
  }

  return parsed;
}
