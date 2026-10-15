import type { SourceConfig, ExtraSection, WorkingHoursConfig } from "./types.js";

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
  /**
   * Update the digest from only the stories inserted since it was last written,
   * instead of re-sending the whole trailing 24h every cycle. Cuts that prompt
   * roughly 10x on a busy source; a full rebuild every `DIGEST_FULL_REBUILD_MS`
   * (12h) bounds the drift this accumulates.
   *
   * Defaults to ON — except when `extensions.prompts.buildDigestPrompt` is
   * overridden, where it defaults to OFF. An override written against the old
   * argument list has no way to fold in `previousBullets`, so incremental mode
   * would silently produce a digest of just the newest stories. Set it
   * explicitly once your override handles both modes.
   */
  incrementalDigest?: boolean;
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
  /**
   * Two modes, distinguished by `previousBullets`:
   *
   * - **Full** (`previousBullets` undefined): `bulletDump` holds every story in
   *   the trailing 24h. Derive the bullets from scratch.
   * - **Incremental** (`previousBullets` non-empty): `previousBullets` is the
   *   currently stored TL;DR and `bulletDump` holds ONLY the stories inserted
   *   since it was written. The prompt must ask for the COMPLETE updated list,
   *   not a delta — models otherwise return just the changes and the older
   *   bullets are lost.
   *
   * An override that ignores `previousBullets` will produce a digest of only the
   * new stories, so `features.incrementalDigest` defaults to OFF whenever this
   * hook is overridden. Set it to true once your override handles both modes.
   */
  buildDigestPrompt?(args: { description: string; bulletDump: string; previousBullets?: string[] }): string;
  buildSectionsPrompt?(args: { description: string; bulletDump: string; sections: ExtraSection[] }): string;
  buildWebsiteDiffPrompt?(args: { description: string; url: string; diffText: string; existingCategories: string[] }): string;
}

export interface TerminalExtensions {
  prompts?: PromptOverrides;
}

export interface StartTerminalOptions {
  port: number;
  dbPath: string;
  /**
   * Required when `authEnabled` is true (the default), and validated at boot:
   * under 8 characters is refused. Unused when auth is disabled.
   */
  appPassword?: string;
  /** Required when `authEnabled` is true (the default); minimum 32 characters. */
  sessionSecret?: string;
  /**
   * Serve the feed without a login. Defaults to true.
   *
   * Only set this to false behind a gate that is not this app — a VPN, an IP
   * allowlist, an authenticated proxy — and never on a port that is directly
   * reachable from the internet. Nothing else in the engine can tell the
   * difference, so disabling auth here is a statement about the network the
   * process sits on, not about the process itself.
   *
   * With it off: `/api/session` reports authenticated, the login screen never
   * renders, `/api/login` 404s, and `appPassword` / `sessionSecret` are not
   * required. CSRF protection stays on — the cookie is issued by the read
   * routes instead of at login.
   */
  authEnabled?: boolean;
  /**
   * Set the session cookie's Secure flag. Defaults to true; deployments without
   * TLS must explicitly set this to false (not recommended for production).
   */
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
  /**
   * Optional day/night cadence: sources refresh on their configured interval
   * inside the window and on `quietIntervalMinutes` outside it. Omitted ⇒ every
   * source keeps its fixed interval around the clock, as before.
   *
   * The window only ever slows a source down — see WorkingHoursConfig.
   */
  workingHours?: WorkingHoursConfig;
  features: FeatureFlags;
  branding: Branding;
  extensions?: TerminalExtensions;
}
