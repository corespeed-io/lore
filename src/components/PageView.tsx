"use client";

import { esc, renderMarkdown } from "@/lib/markdown";
import { useEffect, useRef } from "react";

interface Neighbor {
  slug: string;
  title: string;
}

interface PageViewProps {
  title: string;
  type?: string;
  slug: string;
  body: string;
  neighbors: Neighbor[];
  inGraph: boolean;
  onOpen: (slug: string) => void;
  onGraph: () => void;
}

export function PageView({
  title,
  type,
  slug,
  body,
  neighbors,
  inGraph,
  onOpen,
  onGraph,
}: PageViewProps) {
  const bodyHtml = renderMarkdown(body.replace(/^#\s+.*\r?\n+/, ""));
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.innerHTML = bodyHtml;
  }, [bodyHtml]);

  function handleBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest("a.wl");
    if (a) {
      e.preventDefault();
      const s = (a as HTMLAnchorElement).dataset.slug;
      if (s) onOpen(s);
    }
  }

  function handleBodyKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      const a = (e.target as HTMLElement).closest("a.wl");
      if (a) {
        e.preventDefault();
        const s = (a as HTMLAnchorElement).dataset.slug;
        if (s) onOpen(s);
      }
    }
  }

  return (
    <div className="page-wrap">
      <div className="detail-panel">
        {inGraph && (
          <div style={{ marginBottom: "14px" }}>
            <button
              type="button"
              style={{
                background: "none",
                border: "none",
                color: "var(--muted)",
                font: "13px/1 var(--font-inter, ui-sans-serif, sans-serif)",
                cursor: "pointer",
                padding: 0,
              }}
              onClick={onGraph}
            >
              ← Graph
            </button>
          </div>
        )}
        <h2 className="detail-title">{esc(title || slug)}</h2>
        <div className="detail-meta">
          {type && <span className="type-badge">{type}</span>}
          <span className="detail-slug">{slug}</span>
        </div>
        <div
          ref={bodyRef}
          className="detail-body"
          onClick={handleBodyClick}
          onKeyDown={handleBodyKeyDown}
        />
        {neighbors.length > 0 && (
          <div className="detail-neighbors">
            <p className="detail-neighbors-label">{neighbors.length} linked</p>
            <div>
              {neighbors.map((n) => (
                <button
                  key={n.slug}
                  type="button"
                  className="detail-neighbor-btn"
                  onClick={() => onOpen(n.slug)}
                >
                  {n.title || n.slug}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
