import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { getConfig, getSession, getLists, getFeed, getDigest, getSections, refreshList, logout } from "./api";
import type { FeedItem, ListSummary, ListCheckpoint, ListDigest, ListSection, SourceType } from "./api";
import { Login } from "./components/Login";
import { StoryRow } from "./components/StoryRow";
import { SectionBlock } from "./components/SectionBlock";
import { SyncStatusBar } from "./components/SyncStatusBar";
import { CategoryFilterBar } from "./components/CategoryFilterBar";
import { TldrSection } from "./components/TldrSection";
import { deriveCategoryCounts, groupByDay } from "./feedGrouping";
import { loadReadIds, saveReadIds } from "./readState";
import { relativeTime } from "./utils";

const FEED_LIMIT = 100;

// Must match the server's MIN_MANUAL_REFRESH_MS — the minimum gap between
// user/on-open triggered refreshes of a source. The server is authoritative
// (returns 429); this is only for pre-emptively disabling the button + tooltip.
const MIN_REFRESH_MS = 15 * 60 * 1000;

// Tab groups, in display order. X lists lead so they sit at the top and the
// first of them is preselected on load; everything else follows by type.
const SOURCE_GROUP_ORDER: SourceType[] = ["twitter_list", "media_list", "rss_feed", "website_diff"];

const SOURCE_GROUP_LABELS: Record<SourceType, string> = {
  twitter_list: "X Lists",
  media_list: "News",
  rss_feed: "RSS Feeds",
  website_diff: "Website Watch",
};

interface ListGroup {
  type: SourceType;
  label: string;
  lists: ListSummary[];
}

/** Bucket lists by source type in SOURCE_GROUP_ORDER, dropping empty groups. */
function groupListsByType(lists: ListSummary[]): ListGroup[] {
  return SOURCE_GROUP_ORDER.map((type) => ({
    type,
    label: SOURCE_GROUP_LABELS[type],
    lists: lists.filter((l) => l.type === type),
  })).filter((g) => g.lists.length > 0);
}

/** The tab that should be selected by default: the first one in display order (an X list when present). */
function defaultSelectedId(lists: ListSummary[]): string | null {
  return groupListsByType(lists)[0]?.lists[0]?.id ?? null;
}

/** Milliseconds until this source may be manually refreshed again (0 if now). */
function refreshBackoffMsLeft(cp: ListCheckpoint | null | undefined): number {
  if (!cp?.lastFetchCompletedAt) return 0;
  const left = MIN_REFRESH_MS - (Date.now() - Date.parse(cp.lastFetchCompletedAt));
  return left > 0 ? left : 0;
}

/** Whether a client-initiated refresh should even be attempted (not running, not within backoff). */
function isEligibleForClientRefresh(cp: ListCheckpoint | null | undefined): boolean {
  if (cp?.lastFetchStatus === "running") return false;
  return refreshBackoffMsLeft(cp) === 0;
}

function minutesLeftLabel(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 60000))} min`;
}

function statusLabel(checkpoint: ListCheckpoint | null | undefined): string {
  if (!checkpoint || !checkpoint.lastFetchStatus) return "Not yet refreshed";
  switch (checkpoint.lastFetchStatus) {
    case "running":
      return "Refreshing…";
    case "auth_expired":
      return "⚠️ X session expired — refresh cookies on the server";
    case "error":
      return `⚠️ Last refresh failed: ${checkpoint.lastError ?? "unknown error"}`;
    case "ok":
    default:
      return checkpoint.lastFetchCompletedAt
        ? `Updated ${relativeTime(checkpoint.lastFetchCompletedAt)}`
        : "Up to date";
  }
}

function Feed({ title }: { title: string }) {
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [digest, setDigest] = useState<ListDigest | null>(null);
  const [sections, setSections] = useState<ListSection[]>([]);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [backoffNotice, setBackoffNotice] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<number>>(() => loadReadIds());
  const [, setTick] = useState(0);
  const autoRefreshedRef = useRef(false);

  // Read/seen state is per-browser (localStorage), single-user app — no server.
  const setRead = useCallback((ids: number[], read: boolean) => {
    setReadIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (read) next.add(id);
        else next.delete(id);
      }
      saveReadIds(next);
      return next;
    });
  }, []);

  const refreshLists = useCallback(async () => {
    const data = await getLists();
    setLists(data);
    setSelected((prev) => prev ?? defaultSelectedId(data));
  }, []);

  const loadFeed = useCallback(async (listId: string, highlightNew: boolean) => {
    const { items: fetched } = await getFeed(listId, FEED_LIMIT);
    setItems((prevItems) => {
      if (highlightNew) {
        const prevIds = new Set(prevItems.map((i) => i.id));
        setNewIds(new Set(fetched.filter((i) => !prevIds.has(i.id)).map((i) => i.id)));
      } else {
        setNewIds(new Set());
      }
      return fetched;
    });
  }, []);

  const loadDigest = useCallback(async (listId: string) => {
    const result = await getDigest(listId);
    setDigest(result);
  }, []);

  const loadSections = useCallback(async (listId: string) => {
    const result = await getSections(listId);
    setSections(result);
  }, []);

  useEffect(() => {
    refreshLists();
  }, [refreshLists]);

  // On app open, pull fresh data: trigger a refresh for every source that's
  // eligible (not currently running, not refreshed within the last 15 min).
  // Runs once per open; the server enforces the 15-min floor regardless.
  useEffect(() => {
    if (autoRefreshedRef.current || lists.length === 0) return;
    autoRefreshedRef.current = true;
    const eligible = lists.filter((l) => isEligibleForClientRefresh(l.checkpoint));
    if (eligible.length === 0) return;
    Promise.allSettled(eligible.map((l) => refreshList(l.id))).then(() => refreshLists());
  }, [lists, refreshLists]);

  // Re-render every minute so relative timestamps and the refresh-backoff
  // window (button enable/tooltip) update without a manual reload.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setSelectedCategory(null);
    if (selected) {
      loadFeed(selected, false);
      loadDigest(selected);
      loadSections(selected);
    }
  }, [selected, loadFeed, loadDigest, loadSections]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("feed-item", (e) => {
      const payload = JSON.parse((e as MessageEvent).data) as { listId: string };
      refreshLists();
      if (payload.listId === selected) {
        loadFeed(selected, true);
        loadDigest(selected);
        loadSections(selected);
      }
    });
    return () => source.close();
  }, [selected, loadFeed, loadDigest, loadSections, refreshLists]);

  useEffect(() => {
    if (newIds.size === 0) return;
    const t = setTimeout(() => setNewIds(new Set()), 4000);
    return () => clearTimeout(t);
  }, [newIds]);

  async function handleRefresh() {
    if (!selected) return;
    setBackoffNotice(null);
    setRefreshing(true);
    try {
      const result = await refreshList(selected);
      if (!result.ok) {
        setBackoffNotice(
          result.reason === "running"
            ? "A refresh is already running…"
            : `Refreshed recently — try again in ${minutesLeftLabel(result.retryAfterMs ?? MIN_REFRESH_MS)}.`
        );
        return;
      }
      await refreshLists();
    } finally {
      setTimeout(() => setRefreshing(false), 3000);
    }
  }

  async function handleLogout() {
    await logout();
    window.location.reload();
  }

  const selectedList = lists.find((l) => l.id === selected);
  const selectedRunning = selectedList?.checkpoint?.lastFetchStatus === "running";
  const selectedBackoffMs = refreshBackoffMsLeft(selectedList?.checkpoint);
  const refreshDisabled = refreshing || selectedRunning || selectedBackoffMs > 0;
  const refreshTooltip = selectedRunning
    ? "A refresh is already running"
    : selectedBackoffMs > 0
      ? `You can refresh again in ${minutesLeftLabel(selectedBackoffMs)}`
      : "Fetch the latest now";
  const listGroups = useMemo(() => groupListsByType(lists), [lists]);
  const storyItems = items;
  const categories = useMemo(() => deriveCategoryCounts(storyItems), [storyItems]);
  const filteredStories = useMemo(
    () => (selectedCategory ? storyItems.filter((i) => i.category === selectedCategory) : storyItems),
    [storyItems, selectedCategory]
  );
  const unreadCount = useMemo(
    () => filteredStories.reduce((n, i) => n + (readIds.has(i.id) ? 0 : 1), 0),
    [filteredStories, readIds]
  );
  const dayGroups = useMemo(() => groupByDay(filteredStories), [filteredStories]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-pulse" />
          <h1>{title}</h1>
        </div>
        <button className="logout-btn" onClick={handleLogout}>
          Log out
        </button>
      </header>

      <SyncStatusBar lists={lists} />

      <nav className="list-tabs">
        {listGroups.map((group) => (
          <div key={group.type} className="list-group">
            <h2 className="list-group__title">{group.label}</h2>
            <div className="list-group__tabs">
              {group.lists.map((l) => (
                <button
                  key={l.id}
                  className={`list-tab ${l.id === selected ? "list-tab--active" : ""}`}
                  onClick={() => setSelected(l.id)}
                >
                  <span className={`status-dot status-dot--${l.checkpoint?.lastFetchStatus ?? "unknown"}`} />
                  <span className="list-tab__text">{l.description}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <CategoryFilterBar categories={categories} selected={selectedCategory} onSelect={setSelectedCategory} />

      <TldrSection digest={digest} />

      {sections.map((section) => (
        <SectionBlock key={section.title} title={section.title} content={section.content} />
      ))}

      {selectedList && (
        <div className="feed-toolbar">
          <span className="feed-toolbar__count">
            {filteredStories.length} stor{filteredStories.length === 1 ? "y" : "ies"} across {dayGroups.length}{" "}
            day{dayGroups.length === 1 ? "" : "s"}
            {unreadCount > 0 && <span className="feed-toolbar__unread">{unreadCount} unread</span>}
          </span>
          <span className="feed-toolbar__status">{statusLabel(selectedList.checkpoint)}</span>
          {backoffNotice && <span className="feed-toolbar__backoff">{backoffNotice}</span>}
          <button
            className="feed-toolbar__markread"
            onClick={() => setRead(filteredStories.map((i) => i.id), true)}
            disabled={unreadCount === 0}
            title="Mark all shown stories as read"
          >
            Mark all read
          </button>
          {/* Wrapper carries the tooltip: a disabled <button> doesn't fire hover events. */}
          <span className="refresh-wrap" title={refreshTooltip}>
            <button onClick={handleRefresh} disabled={refreshDisabled}>
              {refreshing ? "Refreshing…" : "Refresh now"}
            </button>
          </span>
        </div>
      )}

      <main className="feed">
        {dayGroups.length === 0 && <p className="feed-empty">No updates yet.</p>}
        {dayGroups.map((group) => (
          <section key={group.key} className="day-group">
            <div className="day-group__header">
              <h2 className="day-group__title">{group.label}</h2>
              <span className="day-group__count">{group.items.length} stories</span>
              {group.categoryCounts.length > 0 && (
                <div className="day-group__categories">
                  {group.categoryCounts.map((c) => (
                    <span key={c.category} className="day-group__category">
                      {c.category} <span className="day-group__category-count">{c.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="day-group__rows">
              {group.items.map((item, i) => (
                <StoryRow
                  key={item.id}
                  item={item}
                  index={i + 1}
                  isNew={newIds.has(item.id)}
                  isRead={readIds.has(item.id)}
                  onOpen={() => setRead([item.id], true)}
                  onToggleRead={() => setRead([item.id], !readIds.has(item.id))}
                />
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [title, setTitle] = useState("Pulse");

  useEffect(() => {
    getSession()
      .then((s) => setAuthenticated(s.authenticated))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    getConfig()
      .then(({ branding }) => {
        setTitle(branding.title);
        document.title = branding.title;
        if (branding.theme) document.documentElement.dataset.theme = branding.theme;
      })
      .catch(() => {});
  }, []);

  if (!authChecked) return <div className="loading-screen">Loading…</div>;
  if (!authenticated) return <Login title={title} onSuccess={() => setAuthenticated(true)} />;
  return <Feed title={title} />;
}

export default App;
