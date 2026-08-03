export type FeedItemType = "tweet_update";
export type ListFetchStatus = "ok" | "error" | "running" | "auth_expired";
export type SourceType = "twitter_list" | "media_list" | "rss_feed" | "website_diff";

export interface FeedItem {
  id: number;
  listId: string;
  batchId: string;
  type: FeedItemType;
  brand?: string;
  headline: string;
  summary: string;
  category?: string;
  tags: string[];
  sourceTweetIds: string[];
  sourceUrls: string[];
  itemTimestamp: string;
  createdAt: string;
}

export interface ListCheckpoint {
  listId: string;
  lastFetchStartedAt?: string;
  lastFetchCompletedAt?: string;
  lastFetchStatus?: ListFetchStatus;
  lastError?: string;
  /** When a cycle last produced new items — NOT when one last completed. Drives staleness (see staleness.ts). */
  lastItemAt?: string;
  /** First cycle ever recorded for this source; the staleness baseline before it produces anything. */
  watchingSince?: string;
}

export interface ListSummary {
  id: string;
  type: SourceType;
  description: string;
  refreshIntervalMinutes: number;
  /** Hours without a new item before this source counts as stale; null when staleness alerting is off for it. */
  stalenessThresholdHours: number | null;
  checkpoint: ListCheckpoint | null;
}

export interface ListDigest {
  listId: string;
  bullets: string[];
  generatedAt: string;
  itemCount: number;
}

export interface ListSection {
  listId: string;
  title: string;
  content: string;
  generatedAt: string;
}

function getCsrfToken(): string | undefined {
  return document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("pulse_csrf="))
    ?.split("=")[1];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const csrfToken = method !== "GET" && method !== "HEAD" && method !== "OPTIONS" ? getCsrfToken() : undefined;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export interface Branding {
  title: string;
  theme?: string;
}

export const getConfig = () => api<{ branding: Branding }>("/api/config");
export const getSession = () => api<{ authenticated: boolean }>("/api/session");
export const login = (password: string) =>
  api<{ ok: boolean }>("/api/login", { method: "POST", body: JSON.stringify({ password }) });
export const logout = () => api<{ ok: boolean }>("/api/logout", { method: "POST" });
export const getLists = () => api<ListSummary[]>("/api/lists");
export const getFeed = (listId: string, limit = 50) =>
  api<{ items: FeedItem[] }>(`/api/feed?listId=${encodeURIComponent(listId)}&limit=${limit}`);
export interface RefreshResult {
  ok: boolean;
  reason?: "running" | "recent";
  retryAfterMs?: number;
  nextAllowedAt?: string;
}

export async function refreshList(listId: string): Promise<RefreshResult> {
  const res = await fetch(`/api/lists/${encodeURIComponent(listId)}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, reason: body.reason, retryAfterMs: body.retryAfterMs, nextAllowedAt: body.nextAllowedAt };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return { ok: true };
}
export const getDigest = (listId: string) =>
  api<ListDigest | null>(`/api/digest?listId=${encodeURIComponent(listId)}`);
export const getSections = (listId: string) =>
  api<ListSection[]>(`/api/sections?listId=${encodeURIComponent(listId)}`);
