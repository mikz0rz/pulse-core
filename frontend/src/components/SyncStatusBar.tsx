import type { ListSummary } from "../api";
import type { StaleSource } from "../staleness";

export function SyncStatusBar({ lists, stale = [] }: { lists: ListSummary[]; stale?: StaleSource[] }) {
  const syncing = lists.filter((l) => l.checkpoint?.lastFetchStatus === "running");
  const failing = lists.filter(
    (l) => l.checkpoint?.lastFetchStatus === "error" || l.checkpoint?.lastFetchStatus === "auth_expired"
  );
  // Silently-stale sources count as needing attention too — otherwise this bar
  // reads "All lists up to date" while a source has been dead for days. The two
  // groups can't overlap: staleness is suppressed for failing sources.
  const attention = failing.length + stale.length;

  let tone: "syncing" | "attention" | "idle" = "idle";
  let text = "All lists up to date";

  if (syncing.length > 0) {
    tone = "syncing";
    text = syncing.length === 1 ? `Syncing ${syncing[0].description}…` : `Syncing ${syncing.length} lists…`;
  } else if (attention > 0) {
    tone = "attention";
    const only = failing[0]?.description ?? stale[0]?.list.description;
    text = attention === 1 ? `${only} needs attention` : `${attention} lists need attention`;
  }

  return (
    <div className={`sync-bar sync-bar--${tone}`}>
      <span className="sync-bar__pulse" />
      <span className="sync-bar__text">{text}</span>
    </div>
  );
}
