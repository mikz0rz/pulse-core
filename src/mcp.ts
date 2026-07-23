#!/usr/bin/env node

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TwitterClient } from "./twitter-client.js";

// ── Validate env ────────────────────────────────────────────────────

const TWITTER_AUTH_TOKEN = process.env.TWITTER_AUTH_TOKEN;
const TWITTER_CT0 = process.env.TWITTER_CT0;

if (!TWITTER_AUTH_TOKEN || !TWITTER_CT0) {
  console.error(
    "Missing required environment variables: TWITTER_AUTH_TOKEN and TWITTER_CT0",
  );
  process.exit(1);
}

const twitter = new TwitterClient(TWITTER_AUTH_TOKEN, TWITTER_CT0);

// ── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: "twitter-mcp",
  version: "1.0.0",
});

// ── Read Tools ──────────────────────────────────────────────────────

server.registerTool("get_home_timeline", {
  description: "Fetch tweets from the authenticated user's home timeline",
  inputSchema: {
    count: z.number().min(1).max(100).default(20).describe("Number of tweets to fetch"),
  },
}, async ({ count }) => {
  const tweets = await twitter.getHomeTimeline(count);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tweets, null, 2) }],
  };
});

server.registerTool("get_user_profile", {
  description: "Get a Twitter user's profile information by their username/handle",
  inputSchema: {
    username: z.string().describe("Twitter username without the @ symbol"),
  },
}, async ({ username }) => {
  const profile = await twitter.getUserProfile(username);
  if (!profile) {
    return {
      content: [{ type: "text" as const, text: `User @${username} not found` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(profile, null, 2) }],
  };
});

server.registerTool("get_user_tweets", {
  description: "Get recent tweets posted by a specific user",
  inputSchema: {
    username: z.string().describe("Twitter username without the @ symbol"),
    count: z.number().min(1).max(100).default(20).describe("Number of tweets to fetch"),
  },
}, async ({ username, count }) => {
  const tweets = await twitter.getUserTweets(username, count);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tweets, null, 2) }],
  };
});

server.registerTool("get_tweet", {
  description: "Get a single tweet by its ID",
  inputSchema: {
    tweet_id: z.string().describe("The tweet ID"),
  },
}, async ({ tweet_id }) => {
  const tweet = await twitter.getTweet(tweet_id);
  if (!tweet) {
    return {
      content: [{ type: "text" as const, text: `Tweet ${tweet_id} not found` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tweet, null, 2) }],
  };
});

server.registerTool("search_tweets", {
  description: "Search for tweets matching a query. Supports Twitter search operators like from:, to:, has:, etc.",
  inputSchema: {
    query: z.string().describe("Search query string"),
    count: z.number().min(1).max(100).default(20).describe("Number of results to return"),
  },
}, async ({ query, count }) => {
  const tweets = await twitter.searchTweets(query, count);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tweets, null, 2) }],
  };
});

server.registerTool("get_trends", {
  description: "Get current trending topics on Twitter",
  inputSchema: {},
}, async () => {
  const trends = await twitter.getTrends();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(trends, null, 2) }],
  };
});

server.registerTool("get_list_tweets", {
  description: "Fetch recent tweets from a specific Twitter List",
  inputSchema: {
    list_id: z.string().describe("The numeric ID of the Twitter List"),
    count: z.number().min(1).max(100).default(20).describe("Number of tweets to fetch"),
    hours: z.number().min(1).optional().describe("Number of hours to look back (overrides count based logic if set)"),
  },
}, async ({ list_id, count, hours }) => {
  const tweets = await twitter.getListTweets(list_id, count, hours);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tweets, null, 2) }],
  };
});

// ── Write Tools ─────────────────────────────────────────────────────

server.registerTool("post_tweet", {
  description: "Post a new tweet. Can also be used to reply by providing reply_to_tweet_id.",
  inputSchema: {
    text: z.string().min(1).max(280).describe("The tweet text content"),
    reply_to_tweet_id: z.string().optional().describe("Tweet ID to reply to (optional)"),
  },
}, async ({ text, reply_to_tweet_id }) => {
  const result = await twitter.postTweet(text, reply_to_tweet_id);
  return {
    content: [{ type: "text" as const, text: result }],
  };
});

server.registerTool("like_tweet", {
  description: "Like a tweet by its ID",
  inputSchema: {
    tweet_id: z.string().describe("The tweet ID to like"),
  },
}, async ({ tweet_id }) => {
  const success = await twitter.likeTweet(tweet_id);
  return {
    content: [{
      type: "text" as const,
      text: success ? `Liked tweet ${tweet_id}` : `Failed to like tweet ${tweet_id}`,
    }],
    isError: !success,
  };
});

server.registerTool("unlike_tweet", {
  description: "Unlike a previously liked tweet by its ID",
  inputSchema: {
    tweet_id: z.string().describe("The tweet ID to unlike"),
  },
}, async ({ tweet_id }) => {
  const success = await twitter.unlikeTweet(tweet_id);
  return {
    content: [{
      type: "text" as const,
      text: success ? `Unliked tweet ${tweet_id}` : `Failed to unlike tweet ${tweet_id}`,
    }],
    isError: !success,
  };
});

server.registerTool("retweet", {
  description: "Retweet a tweet by its ID",
  inputSchema: {
    tweet_id: z.string().describe("The tweet ID to retweet"),
  },
}, async ({ tweet_id }) => {
  const success = await twitter.retweet(tweet_id);
  return {
    content: [{
      type: "text" as const,
      text: success ? `Retweeted tweet ${tweet_id}` : `Failed to retweet tweet ${tweet_id}`,
    }],
    isError: !success,
  };
});

server.registerTool("unretweet", {
  description: "Remove a retweet by the original tweet's ID",
  inputSchema: {
    tweet_id: z.string().describe("The tweet ID to unretweet"),
  },
}, async ({ tweet_id }) => {
  const success = await twitter.unretweet(tweet_id);
  return {
    content: [{
      type: "text" as const,
      text: success ? `Unretweeted tweet ${tweet_id}` : `Failed to unretweet tweet ${tweet_id}`,
    }],
    isError: !success,
  };
});

server.registerTool("reply_to_tweet", {
  description: "Reply to a specific tweet",
  inputSchema: {
    tweet_id: z.string().describe("The tweet ID to reply to"),
    text: z.string().min(1).max(280).describe("The reply text content"),
  },
}, async ({ tweet_id, text }) => {
  const result = await twitter.postTweet(text, tweet_id);
  return {
    content: [{ type: "text" as const, text: result }],
  };
});

// ── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Twitter MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
