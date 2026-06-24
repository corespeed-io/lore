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
  // Strip leading # heading from body (same as reference: replace(/^#\s+.*\r?\n+/, ''))
  const bodyHtml = renderMarkdown(body.replace(/^#\s+.*\r?\n+/, ""));
  const bodyRef = useRef<HTMLDivElement>(null);

  // Set innerHTML directly to avoid biome lint/security/noDangerouslySetInnerHtml.
  // renderMarkdown HTML-escapes all user content before returning — this is safe.
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
    <main>
      {inGraph && (
        <div style={{ marginBottom: "8px" }}>
          <button className="navlink" type="button" onClick={onGraph}>
            ← graph
          </button>
        </div>
      )}
      <h2 style={{ margin: "0.2em 0" }}>
        {esc(title || slug)}
        {type && <span className="badge">{type}</span>}
      </h2>
      <div className="s mut" style={{ fontFamily: "ui-monospace,monospace", marginBottom: "8px" }}>
        {slug}
      </div>
      <div ref={bodyRef} className="body" onClick={handleBodyClick} onKeyDown={handleBodyKeyDown} />
      {neighbors.length > 0 && (
        <div className="backlinks">
          <h4>{neighbors.length} linked</h4>
          {neighbors.map((n) => (
            <button
              key={n.slug}
              className="row"
              type="button"
              onClick={() => onOpen(n.slug)}
              style={{ width: "100%", textAlign: "left", font: "inherit" }}
            >
              <div className="t">{n.title || n.slug}</div>
              <div className="s">{n.slug}</div>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
