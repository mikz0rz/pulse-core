import type { FeedItem } from "../api";
import { relativeTime, isWithinHours, isHttpUrl } from "../utils";

export function StoryRow({
  item,
  index,
  isNew,
  isRead,
  onOpen,
  onToggleRead,
}: {
  item: FeedItem;
  index: number;
  isNew: boolean;
  isRead: boolean;
  onOpen: () => void;
  onToggleRead: () => void;
}) {
  const trending = item.sourceUrls.length >= 3;
  const isRecent = isWithinHours(item.itemTimestamp, 3);
  const primaryUrl = isHttpUrl(item.sourceUrls[0]) ? item.sourceUrls[0] : undefined;

  return (
    <div
      className={`story-row ${isNew ? "story-row--new" : ""} ${isRead ? "story-row--read" : "story-row--unread"}`}
    >
      <div className="story-row__gutter">
        {/* The dot is both the unread indicator and the read/unread toggle. */}
        <button
          type="button"
          className="story-row__dot"
          onClick={onToggleRead}
          title={isRead ? "Mark as unread" : "Mark as read"}
          aria-label={isRead ? "Mark as unread" : "Mark as read"}
          aria-pressed={isRead}
        />
        <span className="story-row__num">{index}</span>
      </div>
      <div className="story-row__main">
        <div className="story-row__headline-wrap">
          {trending && (
            <span className="story-row__trend" title={`${item.sourceUrls.length} sources`}>
              ↗
            </span>
          )}
          {isRecent && <span className="story-row__badge">NEW</span>}
          {item.brand && <span className="story-row__brand">{item.brand}</span>}
          {primaryUrl ? (
            // Opening the story (following its source) marks it read.
            <a className="story-row__headline" href={primaryUrl} target="_blank" rel="noreferrer" onClick={onOpen}>
              {item.headline}
            </a>
          ) : (
            <span className="story-row__headline">{item.headline}</span>
          )}
        </div>
        {item.summary && <p className="story-row__summary">{item.summary}</p>}
      </div>
      <div className="story-row__meta">
        {item.category && <span className="story-row__category">{item.category}</span>}
        <span className="story-row__time">{relativeTime(item.itemTimestamp)}</span>
        {item.sourceUrls.length > 0 && (
          <span className="story-row__sources">
            {item.sourceUrls.length} src{item.sourceUrls.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
