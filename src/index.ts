// Public entry point for pulse-core. Consumers compose the engine through
// startTerminal() and the exported types; everything else is internal.

export { startTerminal } from "./terminal.js";
export { loadSourceConfigs } from "./sources-config.js";

export type {
  StartTerminalOptions,
  FeatureFlags,
  LlmConfig,
  LlmProvider,
  TwitterCredentials,
  Branding,
  PromptOverrides,
  TerminalExtensions,
} from "./terminal-config.js";

export type {
  SourceConfig,
  SourceType,
  TwitterListSourceConfig,
  MediaListSourceConfig,
  RssFeedSourceConfig,
  WebsiteDiffSourceConfig,
  ExtraSection,
  FeedItem,
  ListDigest,
  ListSection,
  ListCheckpoint,
} from "./types.js";
