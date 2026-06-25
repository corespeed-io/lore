"use client";

import { plain } from "@/lib/markdown";

interface Hit {
  slug: string;
  title?: string;
  type?: string;
  chunk_text?: string;
}

interface SearchResultsProps {
  items: Hit[];
  kind: "list" | "search";
  onOpen: (slug: string) => void;
}

export function SearchResults({ items, kind, onOpen }: SearchResultsProps) {
  if (!items.length) {
    return (
      <div className="page-wrap">
        <p style={{ color: "var(--muted)" }}>Nothing found.</p>
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <div className="search-list">
        {items.map((p) => (
          <button key={p.slug} type="button" className="search-row" onClick={() => onOpen(p.slug)}>
            <div className="search-row-title">
              {p.title || p.slug}
              {p.type && <span className="badge">{p.type}</span>}
            </div>
            <div className="search-row-slug">{p.slug}</div>
            {kind === "search" && p.chunk_text && (
              <div className="search-row-snip">{plain(p.chunk_text).slice(0, 180)}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
