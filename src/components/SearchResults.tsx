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
      <main>
        <div className="mut">nothing found.</div>
      </main>
    );
  }

  return (
    <main>
      {items.map((p) => (
        <button
          key={p.slug}
          className="row"
          type="button"
          onClick={() => onOpen(p.slug)}
          style={{ width: "100%", textAlign: "left", font: "inherit" }}
        >
          <div className="t">
            {p.title || p.slug}
            {p.type && <span className="badge">{p.type}</span>}
          </div>
          <div className="s">{p.slug}</div>
          {kind === "search" && p.chunk_text && (
            <div className="snip">{plain(p.chunk_text).slice(0, 180)}</div>
          )}
        </button>
      ))}
    </main>
  );
}
