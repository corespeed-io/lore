"use client";

import { renderMarkdown } from "@/lib/markdown";
import { useEffect, useMemo, useRef } from "react";

interface PageLink {
  slug: string;
  title: string;
}

interface PageViewProps {
  title: string;
  type?: string;
  slug: string;
  body: string;
  backlinks: PageLink[];
  outgoing: PageLink[];
  related: PageLink[];
  backLabel: string;
  onBack: () => void;
  onOpen: (slug: string) => void;
  onLocalGraph: (slug: string) => void;
}

function linkKey(link: PageLink, i: number): string {
  return `${link.slug}-${i}`;
}

function LinkSection({
  title,
  links,
  empty,
  onOpen,
}: {
  title: string;
  links: PageLink[];
  empty: string;
  onOpen: (slug: string) => void;
}) {
  return (
    <section className="context-section">
      <div className="context-heading">
        <h3>{title}</h3>
        <span>{links.length}</span>
      </div>
      {links.length ? (
        <div className="context-link-list">
          {links.map((link, i) => (
            <button
              key={linkKey(link, i)}
              type="button"
              className="context-link"
              onClick={() => onOpen(link.slug)}
            >
              <span className="context-link-title">{link.title || link.slug}</span>
              <span className="context-link-slug">{link.slug}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="context-empty">{empty}</p>
      )}
    </section>
  );
}

export function PageView({
  title,
  type,
  slug,
  body,
  backlinks,
  outgoing,
  related,
  backLabel,
  onBack,
  onOpen,
  onLocalGraph,
}: PageViewProps) {
  const bodyHtml = renderMarkdown(body.replace(/^#\s+.*\r?\n+/, ""));
  const bodyRef = useRef<HTMLDivElement>(null);
  const hasGraphContext = related.length > 0;
  const relatedOnly = useMemo(() => {
    const seen = new Set([
      slug,
      ...backlinks.map((link) => link.slug),
      ...outgoing.map((link) => link.slug),
    ]);
    const unique: PageLink[] = [];
    for (const link of related) {
      if (!link.slug || seen.has(link.slug)) continue;
      seen.add(link.slug);
      unique.push(link);
    }
    return unique;
  }, [backlinks, outgoing, related, slug]);

  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.innerHTML = bodyHtml;
    for (const link of bodyRef.current.querySelectorAll<HTMLAnchorElement>("a.wl")) {
      link.setAttribute("role", "button");
      link.tabIndex = 0;
    }
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
    <div className="page-wrap page-wrap-wide">
      <button type="button" className="back-link" onClick={onBack}>
        ← {backLabel}
      </button>
      <div className="page-detail-grid">
        <article className="detail-panel">
          <h1 className="detail-title">{title || slug}</h1>
          <div className="detail-meta">
            {type && <span className="type-badge">{type}</span>}
            <span className="detail-slug">{slug}</span>
          </div>
          {body.trim() ? (
            <div
              ref={bodyRef}
              className="detail-body"
              onClick={handleBodyClick}
              onKeyDown={handleBodyKeyDown}
            />
          ) : (
            <p className="detail-placeholder">No body available</p>
          )}
        </article>

        <aside className="page-context" aria-label="Page context">
          <section className="context-section context-section-first">
            <div className="context-heading">
              <h3>Properties</h3>
            </div>
            <dl className="property-list">
              <div className="property-row">
                <dt>Type</dt>
                <dd>{type || "unknown"}</dd>
              </div>
              <div className="property-row">
                <dt>Slug</dt>
                <dd>{slug}</dd>
              </div>
              <div className="property-row">
                <dt>Links</dt>
                <dd>
                  {backlinks.length} in / {outgoing.length} out
                </dd>
              </div>
              {hasGraphContext && (
                <div className="property-row">
                  <dt>Graph</dt>
                  <dd>
                    <button
                      type="button"
                      className="property-action"
                      onClick={() => onLocalGraph(slug)}
                    >
                      Open local graph
                    </button>
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <LinkSection title="Backlinks" links={backlinks} empty="No backlinks" onOpen={onOpen} />
          <LinkSection
            title="Outgoing"
            links={outgoing}
            empty="No outgoing links"
            onOpen={onOpen}
          />
          {relatedOnly.length > 0 && (
            <LinkSection
              title="Related"
              links={relatedOnly}
              empty="No extra graph neighbors"
              onOpen={onOpen}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
