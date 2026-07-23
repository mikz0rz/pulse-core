import type { ListDigest } from "../api";

export function TldrSection({ digest }: { digest: ListDigest | null }) {
  if (!digest || digest.bullets.length === 0) return null;

  return (
    <div className="tldr">
      <div className="tldr__header">
        <span className="tldr__label">TL;DR</span>
        <span className="tldr__sub">
          past 24 hours · {digest.itemCount} stor{digest.itemCount === 1 ? "y" : "ies"}
        </span>
      </div>
      <ul className="tldr__bullets">
        {digest.bullets.map((bullet, i) => (
          <li key={i}>{bullet}</li>
        ))}
      </ul>
    </div>
  );
}
