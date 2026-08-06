"use client";

import { useEffect, useRef, useState } from "react";
import { memoryTitle, memoryType } from "@/lib/lore-api";
import { plain } from "@/lib/markdown";
import { typeLabel, typeSort } from "@/lib/type-display";
import type { Memory, MemorySearchResult } from "@/lib/types";

interface SearchResultsProps {
  results: MemorySearchResult[];
  memories: Memory[];
  loading: boolean;
  query: string;
  typeFilter: string;
  onTypeFilter: (type: string) => void;
  onOpen: (memoryId: string) => void;
}

const BROWSE_BATCH = 200;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text: string, terms: string[]): React.ReactNode {
  if (!terms.length || !text) return text;
  const pattern = new RegExp(`(${terms.map(escapeRe).join("|")})`, "gi");
  let offset = 0;
  return text.split(pattern).map((part) => {
    const key = `${offset}:${part}`;
    const matched = terms.some((term) => term.toLocaleLowerCase() === part.toLocaleLowerCase());
    offset += part.length;
    return matched ? (
      <mark key={key} className="hl">
        {part}
      </mark>
    ) : (
      <span key={key}>{part}</span>
    );
  });
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : DATE_FORMAT.format(date);
}

export function SearchResults({
  results,
  memories,
  loading,
  query,
  typeFilter,
  onTypeFilter,
  onOpen,
}: SearchResultsProps) {
  const normalizedQuery = query.trim();
  const [rowLimit, setRowLimit] = useState(BROWSE_BATCH);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listKey = `${typeFilter}|${memories.length}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: listKey is the intentional reset signal.
  useEffect(() => setRowLimit(BROWSE_BATCH), [listKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query/listKey determine whether the sentinel exists.
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRowLimit((current) => current + BROWSE_BATCH);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [listKey, normalizedQuery]);

  if (!normalizedQuery) {
    if (loading) {
      return (
        <div className="page-wrap">
          <p className="muted-note">Loading memories…</p>
        </div>
      );
    }
    if (!memories.length) {
      return (
        <div className="page-wrap">
          <p className="muted-note">No Memories in this Workspace yet.</p>
        </div>
      );
    }

    const counts = Object.create(null) as Record<string, number>;
    for (const memory of memories) {
      const type = memoryType(memory);
      counts[type] = (counts[type] ?? 0) + 1;
    }
    const types = Object.keys(counts).sort(typeSort);
    const chips: [string, string][] = [
      ["all", "All"],
      ...types.map((type): [string, string] => [type, typeLabel(type)]),
    ];
    const filtered =
      typeFilter === "all"
        ? memories
        : memories.filter((memory) => memoryType(memory) === typeFilter);
    const shown = filtered.slice(0, rowLimit);

    return (
      <div className="page-wrap">
        <div className="memories-head">
          <p>
            Showing {filtered.length}
            {typeFilter !== "all" ? ` of ${memories.length}` : ""} memories
          </p>
          {memories.length >= 20_000 && (
            <span>Showing the first {memories.length} Memories. Use search for older matches.</span>
          )}
        </div>
        <div className="chip-row">
          {chips.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`chip${typeFilter === key ? " chip-active" : ""}`}
              onClick={() => onTypeFilter(key)}
            >
              {label}{" "}
              <span className="chip-count">{key === "all" ? memories.length : counts[key]}</span>
            </button>
          ))}
        </div>
        <div className="search-list">
          {shown.map((memory) => (
            <button
              key={memory.id}
              type="button"
              className="search-row"
              onClick={() => onOpen(memory.id)}
            >
              <div className="search-row-title">
                {memoryTitle(memory)}
                <span className="badge">{memoryType(memory)}</span>
              </div>
              <div className="search-row-foot">
                <span className="search-row-id">{memory.id}</span>
                <span className="activity-date">{shortDate(memory.updatedAt)}</span>
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

  const terms = normalizedQuery
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  if (!results.length) {
    return (
      <div className="page-wrap">
        <p className="muted-note">No matches for “{normalizedQuery}”.</p>
      </div>
    );
  }

  const maxScore = Math.max(...results.map((result) => result.score), 0.0001);

  return (
    <div className="page-wrap">
      <div className="search-list">
        {results.map(({ memory, score, evidence }) => {
          const snippet = plain(evidence || memory.content).slice(0, 200);
          return (
            <button
              key={memory.id}
              type="button"
              className="search-row"
              onClick={() => onOpen(memory.id)}
            >
              <div className="search-row-title">
                {highlight(memoryTitle(memory), terms)}
                <span className="badge">{memoryType(memory)}</span>
              </div>
              <div className="search-row-id">{memory.id}</div>
              {snippet && <div className="search-row-snip">{highlight(snippet, terms)}</div>}
              <div className="search-row-foot">
                <span className="relevance-track">
                  <span
                    className="relevance-fill"
                    style={{ width: `${(score / maxScore) * 100}%` }}
                  />
                </span>
                <span className="evidence-tag">ranked recall</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
