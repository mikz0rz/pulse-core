import { request } from "undici";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import type { Tweet, UserProfile, TrendItem } from "./types.js";

const puppeteer = puppeteerExtra as any;
puppeteer.use(StealthPlugin());

const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const GRAPHQL_BASE = "https://x.com/i/api/graphql";

const DEFAULT_FEATURES: Record<string, boolean> = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  tweetypie_unmention_optimization_enabled: true,
};

const QUERY_IDS: Record<string, string> = {
  HomeTimeline: "HJFjzBgCs16TqxewQOeLNg",
  HomeLatestTimeline: "DiTkXJgAKXcS_buyLnSPCA",
  UserByScreenName: "xmU6X_CKVnQ5lSrCbAmJsg",
  UserTweets: "E3opETHurmVJflFsUBVuUQ",
  TweetDetail: "nBS-WpgA6ZG0CyNHD517JQ",
  TweetResultByRestId: "DJSqGOkuGNMpfQDENkkCaA",
  SearchTimeline: "gkjsKepM6gl_HmFWoWKfgg",
  CreateTweet: "a1p9RWpkYKBjWv_I3WzS-A",
  FavoriteTweet: "lI07N6Otwv1PhnEgXILM7A",
  UnfavoriteTweet: "ZYKSe-w7KEslx3JhSIk5LA",
  CreateRetweet: "ojPdsZsimiJrUGLR1sjVsA",
  DeleteRetweet: "iQtK4dl5hBmXewYZuEOKVw",
  GenericTimelineById: "ErACkALGl_J_y6Mqefsb0g",
};

export class TwitterClient {
  private authToken: string;
  private ct0: string;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(authToken: string, ct0: string) {
    this.authToken = authToken;
    this.ct0 = ct0;
  }

  // ── Puppeteer browser (lazy init, for write ops) ──────────────────

  private async getBrowserPage(): Promise<Page> {
    if (this.page && this.browser?.connected) return this.page;

    console.error("[twitter-mcp] Launching stealth browser...");
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1920,1080",
      ],
      defaultViewport: { width: 1920, height: 1080 },
    });

    this.page = await this.browser!.newPage();
    await this.page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    await this.page.setCookie(
      {
        name: "auth_token",
        value: this.authToken,
        domain: ".x.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
      {
        name: "ct0",
        value: this.ct0,
        domain: ".x.com",
        path: "/",
        secure: true,
      },
    );

    await this.page.goto("https://x.com/home", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Refresh ct0 from browser
    const cookies = await this.page.cookies("https://x.com");
    const freshCt0 = cookies.find((c) => c.name === "ct0");
    if (freshCt0 && freshCt0.value !== this.ct0) {
      console.error("[twitter-mcp] ct0 refreshed via browser");
      this.ct0 = freshCt0.value;
    }

    console.error("[twitter-mcp] Browser ready");
    return this.page;
  }

  /**
   * Navigate a tweet by composing through the Twitter UI using Puppeteer.
   * Uses Ctrl+Enter to submit — fully bypasses anti-bot detection.
   */
  private async browserComposeTweet(text: string, replyToTweetId?: string): Promise<string> {
    const page = await this.getBrowserPage();

    if (replyToTweetId) {
      // Navigate to the tweet and click reply
      await page.goto(`https://x.com/i/status/${replyToTweetId}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      // Click the reply button
      const replyButton = await page.waitForSelector(
        `[data-testid="reply"]`,
        { timeout: 10000 },
      );
      if (replyButton) await replyButton.click();
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      await page.goto("https://x.com/compose/post", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
    }

    // Wait for compose textbox
    const textbox = await page.waitForSelector(
      '[data-testid="tweetTextarea_0"], [role="textbox"]',
      { timeout: 15000 },
    );
    if (!textbox) throw new Error("Could not find compose textbox");

    await textbox.click();
    await new Promise((r) => setTimeout(r, 500));

    // Type the tweet line by line
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "" && i > 0) {
        await page.keyboard.press("Enter");
      } else if (line !== "") {
        await page.keyboard.type(line, { delay: 8 });
        if (i < lines.length - 1) {
          await page.keyboard.press("Enter");
        }
      }
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Dismiss any autocomplete dropdown
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 500));

    // Submit with Ctrl+Enter
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");

    // Wait for confirmation
    await new Promise((r) => setTimeout(r, 5000));

    // Verify post was sent by checking for confirmation text
    const pageText = await page.evaluate(() => document.body.innerText);
    if (pageText.includes("Your post was sent") || pageText.includes("Your reply was sent")) {
      return "success";
    }

    // Check if we got redirected away from compose
    const currentUrl = page.url();
    if (!currentUrl.includes("compose")) {
      return "success";
    }

    return "unknown";
  }

  /**
   * Execute a GraphQL mutation through Puppeteer's browser context.
   * Used for like/unlike/retweet/unretweet where UI interaction isn't needed.
   */
  private async browserGraphqlPost(
    queryId: string,
    operationName: string,
    variables: Record<string, unknown>,
    features: Record<string, boolean> = DEFAULT_FEATURES,
  ): Promise<unknown> {
    const page = await this.getBrowserPage();

    const cookies = await page.cookies("https://x.com");
    const ct0Cookie = cookies.find((c) => c.name === "ct0");
    if (ct0Cookie) this.ct0 = ct0Cookie.value;

    const url = `${GRAPHQL_BASE}/${queryId}/${operationName}`;
    const payload = JSON.stringify({ variables, features, queryId });
    const ct0 = this.ct0;
    const bearer = BEARER_TOKEN;

    const result = await page.evaluate(
      async (url: string, payload: string, ct0: string, bearer: string) => {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            "x-csrf-token": ct0,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session",
            "x-twitter-client-language": "en",
          },
          body: payload,
        });
        return { status: res.status, body: await res.text() };
      },
      url,
      payload,
      ct0,
      bearer,
    );

    if (result.status >= 400) {
      throw new Error(`Twitter API error ${result.status}: ${result.body}`);
    }

    return JSON.parse(result.body);
  }

  /**
   * Like/unlike/retweet via the Twitter UI using data-testid buttons.
   */
  private async browserInteractWithTweet(
    tweetId: string,
    action: "like" | "unlike" | "retweet" | "unretweet",
  ): Promise<boolean> {
    const page = await this.getBrowserPage();

    await page.goto(`https://x.com/i/status/${tweetId}`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    await new Promise((r) => setTimeout(r, 2000));

    let testId: string;
    switch (action) {
      case "like":
        testId = "like";
        break;
      case "unlike":
        testId = "unlike";
        break;
      case "retweet":
      case "unretweet":
        testId = "retweet";
        break;
    }

    const button = await page.waitForSelector(
      `[data-testid="${testId}"]`,
      { timeout: 10000 },
    );
    if (!button) return false;

    await button.click();

    if (action === "retweet") {
      // Retweet shows a menu — click "Repost"
      await new Promise((r) => setTimeout(r, 1000));
      const repostOption = await page.waitForSelector(
        '[data-testid="retweetConfirm"]',
        { timeout: 5000 },
      );
      if (repostOption) await repostOption.click();
    } else if (action === "unretweet") {
      await new Promise((r) => setTimeout(r, 1000));
      const undoOption = await page.waitForSelector(
        '[data-testid="unretweetConfirm"]',
        { timeout: 5000 },
      );
      if (undoOption) await undoOption.click();
    }

    await new Promise((r) => setTimeout(r, 2000));
    return true;
  }

  // ── HTTP requests via undici (for read ops) ───────────────────────

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      "x-csrf-token": this.ct0,
      Cookie: `auth_token=${this.authToken}; ct0=${this.ct0}`,
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
    };
  }

  private refreshCt0(resHeaders: Record<string, string | string[] | undefined>): void {
    const setCookie = resHeaders["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const c of cookies) {
      if (c.startsWith("ct0=")) {
        const newCt0 = c.split(";")[0].replace("ct0=", "");
        if (newCt0 && newCt0 !== this.ct0) {
          console.error("[twitter-mcp] ct0 refreshed");
          this.ct0 = newCt0;
        }
      }
    }
  }

  private async httpRequest(
    url: string,
    method: "GET" | "POST",
    body?: string,
  ): Promise<{ status: number; data: unknown }> {
    const { statusCode, headers, body: resBody } = await request(url, {
      method,
      headers: this.headers,
      body,
    });

    this.refreshCt0(headers as Record<string, string | string[] | undefined>);
    const text = await resBody.text();

    if (statusCode === 403 && text.includes("353")) {
      console.error("[twitter-mcp] CSRF mismatch, retrying with refreshed ct0...");
      const retry = await request(url, {
        method,
        headers: this.headers,
        body,
      });
      this.refreshCt0(retry.headers as Record<string, string | string[] | undefined>);
      const retryText = await retry.body.text();
      if (!retry.statusCode.toString().startsWith("2")) {
        throw new Error(`Twitter API error ${retry.statusCode}: ${retryText}`);
      }
      return { status: retry.statusCode, data: JSON.parse(retryText) };
    }

    if (statusCode >= 400) {
      throw new Error(`Twitter API error ${statusCode}: ${text}`);
    }

    return { status: statusCode, data: JSON.parse(text) };
  }

  private async graphqlGet(
    queryId: string,
    operationName: string,
    variables: Record<string, unknown>,
    features: Record<string, boolean> = DEFAULT_FEATURES,
  ): Promise<unknown> {
    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(features),
    });

    const url = `${GRAPHQL_BASE}/${queryId}/${operationName}?${params}`;
    const { data } = await this.httpRequest(url, "GET");
    return data;
  }

  // ── Response parsing helpers ──────────────────────────────────────

  private parseTweet(result: any): Tweet | null {
    try {
      const tweet = result?.tweet || result;
      const legacy = tweet?.legacy;
      const core = tweet?.core?.user_results?.result;
      const userLegacy = core?.legacy;

      if (!legacy || !userLegacy) return null;

      // X's GraphQL User object shape is inconsistent across endpoints: some
      // (e.g. UserByScreenName) still nest screen_name/name/avatar under
      // `legacy`, while others (e.g. tweet-embedded users from list/home/user
      // timelines) moved them to a second `core.core`/`core.avatar` object.
      // Prefer the newer shape, falling back to `legacy` for endpoints that
      // haven't migrated.
      const userCore = core?.core;
      const media =
        legacy.extended_entities?.media?.map((m: any) => ({
          type: m.type,
          url: m.media_url_https || m.url,
          preview_url: m.media_url_https,
        })) ?? [];

      return {
        id: legacy.id_str || tweet.rest_id,
        text: legacy.full_text || legacy.text || "",
        author: {
          id: core.rest_id,
          username: userCore?.screen_name ?? userLegacy.screen_name,
          name: userCore?.name ?? userLegacy.name,
          profile_image_url: core?.avatar?.image_url ?? userLegacy.profile_image_url_https,
          verified: core.is_blue_verified ?? false,
        },
        created_at: legacy.created_at,
        likes: legacy.favorite_count ?? 0,
        retweets: legacy.retweet_count ?? 0,
        replies: legacy.reply_count ?? 0,
        quotes: legacy.quote_count ?? 0,
        bookmarks: legacy.bookmark_count ?? 0,
        views: tweet.views?.count
          ? parseInt(tweet.views.count, 10)
          : undefined,
        language: legacy.lang,
        in_reply_to_tweet_id: legacy.in_reply_to_status_id_str || undefined,
        conversation_id: legacy.conversation_id_str || undefined,
        media: media.length > 0 ? media : undefined,
      };
    } catch {
      return null;
    }
  }

  private parseUser(result: any): UserProfile | null {
    try {
      const legacy = result?.legacy;
      if (!legacy) return null;

      // See parseTweet for why both `core` (newer shape) and `legacy` (older
      // shape) are checked — X's User object shape varies by endpoint.
      const userCore = result?.core;

      return {
        id: result.rest_id,
        username: userCore?.screen_name ?? legacy.screen_name,
        name: userCore?.name ?? legacy.name,
        description: legacy.description ?? "",
        profile_image_url: result?.avatar?.image_url ?? legacy.profile_image_url_https,
        profile_banner_url: legacy.profile_banner_url,
        followers_count: legacy.followers_count ?? 0,
        following_count: legacy.friends_count ?? 0,
        tweet_count: legacy.statuses_count ?? 0,
        verified: result.is_blue_verified ?? false,
        created_at: userCore?.created_at ?? legacy.created_at,
        location: legacy.location || undefined,
        url: legacy.url || undefined,
      };
    } catch {
      return null;
    }
  }

  private extractTweetsFromTimeline(data: any): Tweet[] {
    const tweets: Tweet[] = [];
    try {
      const instructions =
        data?.data?.home?.home_timeline_urt?.instructions ??
        data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
        data?.data?.search_by_raw_query?.search_timeline?.timeline
          ?.instructions ??
        data?.data?.list?.tweets_timeline?.timeline?.instructions ??
        [];

      for (const instruction of instructions) {
        const entries = instruction.entries ?? [];
        for (const entry of entries) {
          const tweetResult =
            entry.content?.itemContent?.tweet_results?.result ??
            entry.content?.items?.[0]?.item?.itemContent?.tweet_results
              ?.result;

          if (tweetResult) {
            const innerResult =
              tweetResult.__typename === "TweetWithVisibilityResults"
                ? tweetResult.tweet
                : tweetResult;
            const parsed = this.parseTweet(innerResult);
            if (parsed) tweets.push(parsed);
          }

          if (entry.content?.items) {
            for (const item of entry.content.items) {
              const nestedResult =
                item?.item?.itemContent?.tweet_results?.result;
              if (nestedResult) {
                const innerResult =
                  nestedResult.__typename === "TweetWithVisibilityResults"
                    ? nestedResult.tweet
                    : nestedResult;
                const parsed = this.parseTweet(innerResult);
                if (parsed) tweets.push(parsed);
              }
            }
          }
        }
      }
    } catch {
      // Return whatever we collected
    }
    return tweets;
  }

  // ── Public API — Read operations (fast HTTP via undici) ────────────

  async getHomeTimeline(count: number = 20): Promise<Tweet[]> {
    const data = await this.graphqlGet(
      QUERY_IDS.HomeTimeline,
      "HomeTimeline",
      { count, includePromotedContent: false, latestControlAvailable: true },
    );
    return this.extractTweetsFromTimeline(data);
  }

  async getUserProfile(username: string): Promise<UserProfile | null> {
    const data = (await this.graphqlGet(
      QUERY_IDS.UserByScreenName,
      "UserByScreenName",
      {
        screen_name: username,
        withSafetyModeUserFields: true,
      },
    )) as any;

    return this.parseUser(data?.data?.user?.result);
  }

  async getUserTweets(username: string, count: number = 20): Promise<Tweet[]> {
    const profile = await this.getUserProfile(username);
    if (!profile) throw new Error(`User @${username} not found`);

    const data = await this.graphqlGet(
      QUERY_IDS.UserTweets,
      "UserTweets",
      {
        userId: profile.id,
        count,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      },
    );
    return this.extractTweetsFromTimeline(data);
  }

  async getTweet(tweetId: string): Promise<Tweet | null> {
    const data = (await this.graphqlGet(
      QUERY_IDS.TweetResultByRestId,
      "TweetResultByRestId",
      { tweetId, withCommunity: false, includePromotedContent: false, withVoice: false },
    )) as any;

    const result = data?.data?.tweetResult?.result;
    if (!result) return null;

    const innerResult =
      result.__typename === "TweetWithVisibilityResults"
        ? result.tweet
        : result;
    return this.parseTweet(innerResult);
  }

  async searchTweets(query: string, count: number = 20): Promise<Tweet[]> {
    const data = await this.graphqlGet(
      QUERY_IDS.SearchTimeline,
      "SearchTimeline",
      {
        rawQuery: query,
        count,
        querySource: "typed_query",
        product: "Latest",
      },
    );
    return this.extractTweetsFromTimeline(data);
  }

  async getTrends(): Promise<TrendItem[]> {
    const url = "https://x.com/i/api/2/guide.json?include_page_configuration=true&initial_tab_id=trending";
    const { data } = await this.httpRequest(url, "GET");
    const trends: TrendItem[] = [];

    try {
      const timeline = (data as any)?.timeline?.instructions ?? [];
      for (const instruction of timeline) {
        const entries = instruction.addEntries?.entries ?? [];
        for (const entry of entries) {
          const items = entry.content?.timelineModule?.items ?? [];
          for (const item of items) {
            const trend = item?.item?.content?.trend;
            if (trend) {
              trends.push({
                name: trend.name,
                tweet_count: trend.trendMetadata?.metaDescription
                  ? parseInt(
                    trend.trendMetadata.metaDescription.replace(/[^0-9]/g, ""),
                    10,
                  ) || undefined
                  : undefined,
                description: trend.trendMetadata?.metaDescription,
                domain: trend.trendMetadata?.domainContext,
              });
            }
          }
        }
      }
    } catch {
      // Return whatever we parsed
    }

    return trends;
  }

  async getListTweets(listId: string, count: number = 20, hours?: number): Promise<Tweet[]> {
    const page = await this.getBrowserPage();

    const accumulatedTweets: Tweet[] = [];
    const seenTweetIds = new Set<string>();

    // specific handler to capture the list timeline response
    const responseHandler = async (response: any) => {
      const url = response.url();
      if ((url.includes("ListLatestTweetsTimeline") || url.includes("ListTweetsTimeline")) &&
        response.request().method() === "GET") {
        try {
          const json = await response.json();
          const tweets = this.extractTweetsFromTimeline(json);
          let newCount = 0;
          for (const t of tweets) {
            if (!seenTweetIds.has(t.id)) {
              seenTweetIds.add(t.id);
              accumulatedTweets.push(t);
              newCount++;
            }
          }
          if (newCount > 0) {
            console.log(`[twitter-mcp] Captured ${newCount} new tweets (Total unique: ${accumulatedTweets.length})`);
          }
        } catch (e) {
          // ignore non-json
        }
      }
    };

    page.on("response", responseHandler);

    try {
      console.log(`[twitter-mcp] Navigating to list: https://x.com/i/lists/${listId}`);
      await page.goto(`https://x.com/i/lists/${listId}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Simple delay to let initial load happen
      await new Promise(r => setTimeout(r, 3000));

      const startTime = Date.now();
      const cutoffTime = hours ? startTime - (hours * 60 * 60 * 1000) : 0;
      let keepScrolling = true;
      let loops = 0;
      const MAX_LOOPS = 20; // Safety break

      while (keepScrolling && loops < MAX_LOOPS) {
        // Check exit conditions
        if (hours) {
          // If we have tweets, check the oldest one
          if (accumulatedTweets.length > 0) {
            // Sort to ensure we check the actual oldest captured so far
            // (Timeline usually gives new first, but good to be safe if we want robustness)
            // For performance, assuming append order roughly matches timeline order (New -> Old)
            const lastTweet = accumulatedTweets[accumulatedTweets.length - 1];
            const tweetDate = new Date(lastTweet.created_at).getTime();
            if (tweetDate < cutoffTime) {
              console.log("[twitter-mcp] Reached time limit window. Stopping.");
              keepScrolling = false;
              break;
            }
          }
        } else {
          // Count based
          if (accumulatedTweets.length >= count) {
            console.log("[twitter-mcp] Reached requested count. Stopping.");
            keepScrolling = false;
            break;
          }
        }

        // Scroll down
        console.log(`[twitter-mcp] Scrolling... (Loop ${loops + 1})`);
        await page.evaluate(() => {
          window.scrollBy(0, 2000);
        });
        
        // Random small delay to mimic human behavior / wait for load
        await new Promise(r => setTimeout(r, 2000));
        
        loops++;
      }

    } catch (e) {
      console.error("[twitter-mcp] Error navigating/scrolling list:", e);
    } finally {
      page.off("response", responseHandler);
    }

    // Post-processing
    let finalTweets = accumulatedTweets;

    if (hours) {
      const startTime = Date.now();
      const cutoffTime = startTime - (hours * 60 * 60 * 1000);
      finalTweets = finalTweets.filter(t => {
         const tDate = new Date(t.created_at).getTime();
         return tDate >= cutoffTime;
      });
      console.log(`[twitter-mcp] Filtered by ${hours} hours. Result: ${finalTweets.length} tweets.`);
    } else {
      // Just slice to count
       finalTweets = finalTweets.slice(0, count);
    }

    return finalTweets;
  }

  // ── Public API — Write operations (via Puppeteer browser UI) ──────

  async postTweet(text: string, replyToTweetId?: string): Promise<string> {
    const result = await this.browserComposeTweet(text, replyToTweetId);
    if (result !== "success") {
      throw new Error("Tweet may not have been posted — could not confirm");
    }
    return "Tweet posted successfully";
  }

  async likeTweet(tweetId: string): Promise<boolean> {
    return this.browserInteractWithTweet(tweetId, "like");
  }

  async unlikeTweet(tweetId: string): Promise<boolean> {
    return this.browserInteractWithTweet(tweetId, "unlike");
  }

  async retweet(tweetId: string): Promise<boolean> {
    return this.browserInteractWithTweet(tweetId, "retweet");
  }

  async unretweet(tweetId: string): Promise<boolean> {
    return this.browserInteractWithTweet(tweetId, "unretweet");
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
