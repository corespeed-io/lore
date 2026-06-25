"use client";

import { esc, renderMarkdown } from "@/lib/markdown";
import { useEffect, useRef } from "react";

interface Neighbor {
  slug: string;
  title: string;
}

interface PageState {
  title: string;
  type: string;
  slug: string;
  body: string;
  neighbors: Neighbor[];
}

interface DetailPanelProps {
  page: PageState | null;
  onOpen: (slug: string) => void;
}

export function DetailPanel({ page, onOpen }: DetailPanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const bodyHtml = page ? renderMarkdown(page.body.replace(/^#\s+.*\r?\n+/, "")) : "";

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
    <div className="detail-panel">
      {!page ? (
        <p className="detail-placeholder">DETAIL · CLICK A NODE</p>
      ) : (
        <>
          <h2 className="detail-title">{esc(page.title || page.slug)}</h2>
          <div className="detail-meta">
            {page.type && <span className="type-badge">{page.type}</span>}
            <span className="detail-slug">{page.slug}</span>
          </div>
          <div
            ref={bodyRef}
            className="detail-body"
            onClick={handleBodyClick}
            onKeyDown={handleBodyKeyDown}
          />
          {page.neighbors.length > 0 && (
            <div className="detail-neighbors">
              <p className="detail-neighbors-label">{page.neighbors.length} linked</p>
              <div>
                {page.neighbors.map((n) => (
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
        </>
      )}
    </div>
  );
}
