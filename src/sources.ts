import type { TwitterClient } from "./twitter-client.js";
import { createTwitterListSource } from "./scheduler.js";
import { createMediaListSource } from "./huggingnews.js";
import { createRssFeedSource, createWebsiteDiffSource } from "./website-watch.js";
import type { Source, SourceConfig } from "./types.js";
import type { FeatureFlags } from "./terminal-config.js";

/**
 * Assembles the active Source list from injected configs, dispatching each
 * entry to its type's factory. `website_diff` sources are dropped when the
 * websiteDiff feature flag is off, so a variant can ship the same config set
 * with competitor-tracking simply disabled. Adding a fifth source category
 * means a SourceConfig variant (types.ts), a factory in that category's
 * module, and one case here — nothing else changes.
 */
export function buildSources(twitter: TwitterClient, configs: SourceConfig[], features: FeatureFlags): Source[] {
  const enabled = configs.filter((c) => c.enabled);
  const sources: Source[] = [];

  for (const config of enabled) {
    switch (config.type) {
      case "twitter_list":
        sources.push(createTwitterListSource(twitter, config));
        break;
      case "media_list":
        sources.push(createMediaListSource(config));
        break;
      case "rss_feed":
        sources.push(createRssFeedSource(config));
        break;
      case "website_diff":
        if (features.websiteDiff) sources.push(createWebsiteDiffSource(config));
        break;
    }
  }

  return sources;
}
