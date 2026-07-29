export interface Snack {
  /** Stable per-alert identity — also what gets passed back to onDismiss. */
  id: string;
  tone?: "error" | "warn";
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}

// Enough alerts to act on, not enough to bury the feed. If every source breaks
// at once (an expired X session, say) the rest collapse into a counted line
// rather than a wall of identical snacks.
const MAX_VISIBLE = 3;

/**
 * Bottom-anchored stack of dismissible alerts for problems that would
 * otherwise go unnoticed — today the silently-stale sources from
 * staleness.ts, which look healthy everywhere else in the UI. Generic on
 * purpose: any condition worth interrupting for can be pushed through it.
 */
export function SnackBar({ snacks, onDismiss }: { snacks: Snack[]; onDismiss: (id: string) => void }) {
  if (snacks.length === 0) return null;

  const visible = snacks.slice(0, MAX_VISIBLE);
  const hidden = snacks.length - visible.length;

  return (
    <div className="snacks" role="alert" aria-live="assertive">
      {visible.map((snack) => (
        <div key={snack.id} className={`snack snack--${snack.tone ?? "error"}`}>
          <div className="snack__body">
            <p className="snack__title">{snack.title}</p>
            {snack.detail && <p className="snack__detail">{snack.detail}</p>}
          </div>
          <div className="snack__actions">
            {snack.actionLabel && snack.onAction && (
              <button className="snack__action" onClick={snack.onAction}>
                {snack.actionLabel}
              </button>
            )}
            <button className="snack__dismiss" onClick={() => onDismiss(snack.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      ))}
      {hidden > 0 && (
        <p className="snacks__more">
          +{hidden} more source{hidden === 1 ? "" : "s"} need attention
        </p>
      )}
    </div>
  );
}
