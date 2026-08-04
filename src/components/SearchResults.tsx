"use client";

import { plain } from "@/lib/markdown";
import { typeLabel, typeSort } from "@/lib/type-display";
import type { PageHit } from "@/lib/types";
import { useEffect, useRef, useState } from "react";

interface SearchResultsProps {
  items: PageHit[];
  allPages: PageHit[];
  query: string;
  typeFilter: string;
  onTypeFilter: (t: string) => void;
  onOpen: (slug: string) => void;
}

const HASH = /^[0-9a-f]{6,}$/i;

// Browse rows revealed per scroll-step. 200 fills several screens, so the
// sentinel is comfortably below the fold and growth is invisible.
const BROWSE_BATCH = 200;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap matched query terms in <mark> (capture-group split → odd indices are matches).
function highlight(text: string, terms: string[]): React.ReactNode {
  if (!terms.length || !text) return text;
  const re = new RegExp(`(${terms.map(escapeRe).join("|")})`, "gi");
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={`${i}-${part}`} className="hl">
        {part}
      </mark>
    ) : (
      <span key={`${i}-${part}`}>{part}</span>
    ),
  );
}

function evidenceLabel(e?: string): string {
  if (!e) return "";
  if (e.includes("vector")) return "semantic";
  if (e.includes("keyword")) return "keyword";
  if (e.includes("graph")) return "graph";
  return e.replace(/_/g, " ");
}

// Readable name: real title, else humanize the slug (dropping hash segments).
function displayName(p: PageHit): string {
  const t = (p.title ?? "").trim();
  if (t && !HASH.test(t)) return t;
  const parts = p.slug.split("/").filter((s) => !HASH.test(s));
  return (parts.pop() ?? p.slug).replace(/-/g, " ");
}

// One formatter, module-wide: toLocaleDateString constructs a fresh
// Intl.DateTimeFormat on every call, which at ~1000 browse rows made each
// re-render (every type-chip click) spend ~10ms formatting the same dates.
const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE_FMT.format(d);
}

export function SearchResults({
  items,
  allPages,
  query,
  typeFilter,
  onTypeFilter,
  onOpen,
}: SearchResultsProps) {
  const q = query.trim();

  // The browse list is every page in the brain (973 today, capped at 20k), and
  // rendering it all as DOM rows up front made the tab's first paint scale with
  // the brain. Rows are revealed in batches instead: a sentinel below the list
  // grows the window whenever it scrolls into view, so a reader who never
  // scrolls pays for 200 rows, and one who does never sees the seam. State
  // lives up here because hooks cannot sit behind the early returns below.
  const [rowLimit, setRowLimit] = useState(BROWSE_BATCH);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listKey = `${typeFilter}|${allPages.length}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: listKey is the reset signal — a new filter or page set restarts the window.
  useEffect(() => setRowLimit(BROWSE_BATCH), [listKey]);
  // Deps include `q` because the sentinel only exists in browse mode: coming
  // back from a search must re-arm the observer on the fresh element. (With no
  // dep array this re-ran on EVERY render, tearing down and rebuilding the
  // observer each time.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: listKey/q gate when the sentinel element can have changed.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setRowLimit((n) => n + BROWSE_BATCH);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [listKey, q]);

  // No query → Memories browse: the full page list, newest first, filterable by type.
  if (!q) {
    if (!allPages.length) {
      return (
        <div className="page-wrap">
          <p className="muted-note">Loading memories…</p>
        </div>
      );
    }
    const counts: Record<string, number> = {};
    for (const p of allPages) counts[p.type ?? "other"] = (counts[p.type ?? "other"] ?? 0) + 1;
    const types = Object.keys(counts).sort(typeSort);
    const chips: [string, string][] = [
      ["all", "All"],
      ...types.map((t): [string, string] => [t, typeLabel(t)]),
    ];
    const filtered =
      typeFilter === "all" ? allPages : allPages.filter((p) => p.type === typeFilter);
    const shown = filtered.slice(0, rowLimit);
    // True only when the browse list hit its hard cap — full paging made the
    // old >=100 heuristic ("showing the first N") untrue the moment it shipped.
    const maybeLimited = allPages.length >= 20_000;
    return (
      <div className="page-wrap">
        <div className="memories-head">
          <p>
            Showing {filtered.length}
            {typeFilter !== "all" ? ` of ${allPages.length}` : ""} memories
          </p>
          {maybeLimited && (
            <span>Showing the first {allPages.length} pages. Use search for older matches.</span>
          )}
        </div>
        <div className="chip-row">
          {chips.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`chip${typeFilter === k ? " chip-active" : ""}`}
              onClick={() => onTypeFilter(k)}
            >
              {label}{" "}
              <span className="chip-count">{k === "all" ? allPages.length : counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="search-list">
          {shown.map((p) => (
            <button
              key={p.slug}
              type="button"
              className="search-row"
              onClick={() => onOpen(p.slug)}
            >
              <div className="search-row-title">
                {displayName(p)}
                {p.type && <span className="badge">{p.type}</span>}
              </div>
              <div className="search-row-foot">
                <span className="search-row-slug">{p.slug}</span>
                <span className="activity-date">{shortDate(p.updated_at)}</span>
              </div>
            </button>
          ))}
          {shown.length < filtered.length && (
            <div ref={sentinelRef} className="search-list-sentinel" aria-hidden="true" />
          )}
        </div>
      </div>
    );
  }

  // Query → ranked hybrid search.
  const terms = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  if (!items.length) {
    return (
      <div className="page-wrap">
        <p className="muted-note">No matches for “{q}”.</p>
      </div>
    );
  }

  const maxScore = Math.max(...items.map((p) => p.score ?? 0), 0.0001);

  return (
    <div className="page-wrap">
      <div className="search-list">
        {items.map((p) => {
          const snippet = p.chunk_text ? plain(p.chunk_text).slice(0, 200) : "";
          const ev = evidenceLabel(p.evidence);
          return (
            <button
              key={p.slug}
              type="button"
              className="search-row"
              onClick={() => onOpen(p.slug)}
            >
              <div className="search-row-title">
                {highlight(displayName(p), terms)}
                {p.type && <span className="badge">{p.type}</span>}
              </div>
              <div className="search-row-slug">{p.slug}</div>
              {snippet && <div className="search-row-snip">{highlight(snippet, terms)}</div>}
              {(p.score !== undefined || ev) && (
                <div className="search-row-foot">
                  <span className="relevance-track">
                    <span
                      className="relevance-fill"
                      style={{ width: `${((p.score ?? 0) / maxScore) * 100}%` }}
                    />
                  </span>
                  {ev && <span className="evidence-tag">{ev}</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
