import type { ListSummary } from "../api";

export function SyncStatusBar({ lists }: { lists: ListSummary[] }) {
  const syncing = lists.filter((l) => l.checkpoint?.lastFetchStatus === "running");
  const attention = lists.filter(
    (l) => l.checkpoint?.lastFetchStatus === "error" || l.checkpoint?.lastFetchStatus === "auth_expired"
  );

  let tone: "syncing" | "attention" | "idle" = "idle";
  let text = "All lists up to date";

  if (syncing.length > 0) {
    tone = "syncing";
    text = syncing.length === 1 ? `Syncing ${syncing[0].description}…` : `Syncing ${syncing.length} lists…`;
  } else if (attention.length > 0) {
    tone = "attention";
    text = attention.length === 1 ? `${attention[0].description} needs attention` : `${attention.length} lists need attention`;
  }

  return (
    <div className={`sync-bar sync-bar--${tone}`}>
      <span className="sync-bar__pulse" />
      <span className="sync-bar__text">{text}</span>
    </div>
  );
}
