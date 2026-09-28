"use client";

import type { Memory, MemorySearchResult } from "@corespeed/lore-sdk";
import { useCallback, useEffect, useState } from "react";
import { MAX_MEMORY_PAGES, MEMORY_PAGE_SIZE } from "@/modules/memories/browser/data";
import { plain } from "@/modules/memories/browser/markdown";
import {
  browseCounts,
  browseFilterEmptyNote,
  browseTypeChips,
  memoryConfiguredType,
  memoryTitle,
  memoryType,
  shortMemoryDate,
} from "@/modules/memories/browser/presentation";

const BROWSE_WINDOW = MEMORY_PAGE_SIZE * MAX_MEMORY_PAGES;

interface SearchResultsProps {
  workspaceId: string;
  results: readonly MemorySearchResult[];
  memories: Memory[];
  capped: boolean;
  /** Every browse page was read, so the counts are exact. */
  complete: boolean;
  loading: boolean;
  /** The browse read failed before any Memory arrived. */
  browseError: string | null;
  error: string | null;
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

/** Scope is explicit text on every Memory row; a type badge appears only when set. */
function MemoryRowLabels({ memory }: { memory: Memory }) {
  const type = memoryConfiguredType(memory);
  return (
    <>
      {type && <span className="badge">{type}</span>}
      <span className="memory-scope">{memory.scope}</span>
    </>
  );
}

export function SearchResults({
  workspaceId,
  results,
  memories,
  capped,
  complete,
  loading,
  browseError,
  error,
  query,
  typeFilter,
  onTypeFilter,
  onOpen,
}: SearchResultsProps) {
  const normalizedQuery = query.trim();
  const [rowLimit, setRowLimit] = useState(BROWSE_BATCH);
  // Only a different list resets the window. Browse keeps filling pages into
  // `memories`, and resetting on its length would snap the scroll back to 200 rows.
  const listKey = `${workspaceId}|${typeFilter}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: listKey is the intentional reset signal.
  useEffect(() => setRowLimit(BROWSE_BATCH), [listKey]);

  // A callback ref observes the sentinel whenever it mounts, including when a
  // later browse page first makes the list longer than the current window.
  const observeSentinel = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRowLimit((current) => current + BROWSE_BATCH);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
          <p className="muted-note">
            {/* The shell's alert banner already carries the error detail. */}
            {browseError
              ? "This Workspace's Memories couldn't be loaded."
              : "No Memories in this Workspace yet."}
          </p>
        </div>
      );
    }

    const typeCounts = Object.create(null) as Record<string, number>;
    for (const memory of memories) {
      const type = memoryType(memory);
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }
    const chips = browseTypeChips(Object.keys(typeCounts), typeFilter);
    const filtered =
      typeFilter === "all"
        ? memories
        : memories.filter((memory) => memoryType(memory) === typeFilter);
    const shown = filtered.slice(0, rowLimit);
    const counts = browseCounts({
      matching: filtered.length,
      total: memories.length,
      filtered: typeFilter !== "all",
      complete,
    });
    const emptyNote = browseFilterEmptyNote({
      type: typeFilter,
      matching: filtered.length,
      complete,
      capped,
    });

    return (
      <div className="page-wrap">
        <div className="memories-head">
          <p>{counts.heading}</p>
          {capped && (
            <span>
              Browse is limited to {BROWSE_WINDOW.toLocaleString("en-US")} Memories. Search covers
              the Workspace.
            </span>
          )}
        </div>
        <div className="chip-row">
          {chips.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`chip${typeFilter === key ? " chip-active" : ""}`}
              aria-pressed={typeFilter === key}
              onClick={() => onTypeFilter(key)}
            >
              {label}{" "}
              <span className="chip-count">
                {counts.count(key === "all" ? memories.length : (typeCounts[key] ?? 0))}
              </span>
            </button>
          ))}
        </div>
        {emptyNote && <p className="muted-note">{emptyNote}</p>}
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
                <MemoryRowLabels memory={memory} />
              </div>
              <div className="search-row-foot">
                <span className="search-row-id">{memory.id}</span>
                <span className="activity-date">{shortMemoryDate(memory.updatedAt)}</span>
              </div>
            </button>
          ))}
          {shown.length < filtered.length && (
            <div ref={observeSentinel} className="search-list-sentinel" aria-hidden="true" />
          )}
        </div>
      </div>
    );
  }

  const terms = normalizedQuery
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  if (loading) {
    return (
      <div className="page-wrap">
        <p className="muted-note">Searching memories…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-wrap">
        <p className="muted-note">Couldn&apos;t search this Workspace — {error}.</p>
      </div>
    );
  }

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
                <MemoryRowLabels memory={memory} />
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
