import type { SourceConfig, ExtraSection } from "./types.js";

// ─── Public configuration surface for startTerminal() ───────────────────
// Everything the engine needs is passed IN here by the consumer. The core
// reads NO secrets from the environment itself — API keys, cookies, and the
// app password all arrive through this object.

export type LlmProvider = "openai" | "gemini";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  /** OpenAI-compatible gateways only. Defaults to https://api.openai.com/v1. */
  baseUrl?: string;
  modelId?: string;
}

export interface TwitterCredentials {
  authToken: string;
  ct0: string;
}

/** Which optional capabilities a given deployment turns on. */
export interface FeatureFlags {
  /** Allow `website_diff` sources to be scheduled/shown. */
  websiteDiff: boolean;
  /** Run the per-list `extraSections` strategic synthesis. */
  extraSections: boolean;
  /** Generate the rolling TL;DR digest per source. */
  aiDigest: boolean;
}

export interface Branding {
  title: string;
  theme?: string;
}

// ─── Extension points (grey-zone option B) ──────────────────────────────
// The core ships generic working prompts. A consumer (e.g. a private "pro"
// deployment) can override any of them with tuned wording without that
// wording ever living in the open-source core. Any override provided here
// replaces the core default; anything omitted falls back to the default.

export interface PromptOverrides {
  buildFeedItemsPrompt?(args: { dumpText: string; promptContext?: string; existingCategories: string[] }): string;
  buildDigestPrompt?(args: { description: string; bulletDump: string }): string;
  buildSectionsPrompt?(args: { description: string; bulletDump: string; sections: ExtraSection[] }): string;
  buildWebsiteDiffPrompt?(args: { description: string; url: string; diffText: string; existingCategories: string[] }): string;
}

export interface TerminalExtensions {
  prompts?: PromptOverrides;
}

export interface StartTerminalOptions {
  port: number;
  dbPath: string;
  appPassword: string;
  sessionSecret: string;
  /** Set the session cookie's Secure flag (true behind TLS in production). */
  secureCookie?: boolean;
  llm: LlmConfig;
  twitter: TwitterCredentials;
  huggingNewsApiKey?: string;
  sources: SourceConfig[];
  /**
   * Hours a source may go without a single new item before the UI reports it
   * stale (defaults to 12). Applies to the source types where a dry spell
   * means breakage rather than quiet — see staleness.ts — and is overridable
   * per source via SourceConfig.stalenessThresholdHours. 0 disables the
   * default entirely, leaving only per-source opt-ins.
   */
  stalenessThresholdHours?: number;
  features: FeatureFlags;
  branding: Branding;
  extensions?: TerminalExtensions;
}
