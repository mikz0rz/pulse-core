import type { FeedItem } from "./api";
import { dayKey, dayLabel } from "./utils";

export interface CategoryCount {
  category: string;
  count: number;
}

export interface DayGroup {
  key: string;
  label: string;
  items: FeedItem[];
  categoryCounts: CategoryCount[];
}

function countByCategory(items: FeedItem[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.category) continue;
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));
}

export function deriveCategoryCounts(items: FeedItem[]): CategoryCount[] {
  return countByCategory(items);
}

export function groupByDay(items: FeedItem[]): DayGroup[] {
  const map = new Map<string, FeedItem[]>();
  for (const item of items) {
    const key = dayKey(item.itemTimestamp);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, groupItems]) => ({
      key,
      label: dayLabel(groupItems[0].itemTimestamp),
      items: groupItems,
      categoryCounts: countByCategory(groupItems),
    }));
}
