import type { CategoryCount } from "../feedGrouping";

export function CategoryFilterBar({
  categories,
  selected,
  onSelect,
}: {
  categories: CategoryCount[];
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  if (categories.length === 0) return null;

  return (
    <div className="category-bar">
      <button
        className={`category-chip ${selected === null ? "category-chip--active" : ""}`}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {categories.map((c) => (
        <button
          key={c.category}
          className={`category-chip ${selected === c.category ? "category-chip--active" : ""}`}
          onClick={() => onSelect(selected === c.category ? null : c.category)}
        >
          {c.category} <span className="category-chip__count">{c.count}</span>
        </button>
      ))}
    </div>
  );
}
