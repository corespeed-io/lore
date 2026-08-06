"use client";

import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "@/lib/markdown";
import type { MemoryScope } from "@/lib/types";

interface MemoryLink {
  id: string;
  label: string;
}

interface MemoryViewProps {
  title: string;
  type: string;
  id: string;
  body: string;
  scope: MemoryScope;
  ownerUserId: string;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  related: MemoryLink[];
  backLabel: string;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onOpen: (memoryId: string) => void;
  onLocalGraph: (memoryId: string) => void;
  onEdit: () => void;
  onForget: () => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : DATE_FORMAT.format(date);
}

function RelatedMemories({
  memories,
  onOpen,
}: {
  memories: MemoryLink[];
  onOpen: (memoryId: string) => void;
}) {
  return (
    <section className="context-section">
      <div className="context-heading">
        <h3>Related</h3>
        <span>{memories.length}</span>
      </div>
      {memories.length ? (
        <div className="context-link-list">
          {memories.map((memory) => (
            <button
              key={memory.id}
              type="button"
              className="context-link"
              onClick={() => onOpen(memory.id)}
            >
              <span className="context-link-title">{memory.label}</span>
              <span className="context-link-id">{memory.id}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="context-empty">No derived affinities</p>
      )}
    </section>
  );
}

export function MemoryView({
  title,
  type,
  id,
  body,
  scope,
  ownerUserId,
  createdByAgentId,
  createdAt,
  updatedAt,
  version,
  related,
  backLabel,
  saving,
  error,
  onBack,
  onOpen,
  onLocalGraph,
  onEdit,
  onForget,
}: MemoryViewProps) {
  const bodyHtml = useMemo(() => renderMarkdown(body.replace(/^#\s+.*\r?\n+/, "")), [body]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.innerHTML = bodyHtml;
  }, [bodyHtml]);

  return (
    <div className="page-wrap page-wrap-wide">
      <button type="button" className="back-link" onClick={onBack}>
        ← {backLabel}
      </button>
      {error && <div className="native-error memory-detail-error">{error}</div>}
      <div className="page-detail-grid">
        <article className="detail-panel">
          <h1 className="detail-title">{title || "Untitled memory"}</h1>
          <div className="detail-meta">
            <span className="type-badge">{type}</span>
            <span className="detail-id">{id}</span>
          </div>
          {body.trim() ? (
            <div ref={bodyRef} className="detail-body" />
          ) : (
            <p className="detail-placeholder">No content available</p>
          )}
        </article>

        <aside className="page-context" aria-label="Memory context">
          <section className="context-section context-section-first">
            <div className="context-heading">
              <h3>Properties</h3>
            </div>
            <dl className="property-list">
              <div className="property-row">
                <dt>Type</dt>
                <dd>{type}</dd>
              </div>
              <div className="property-row">
                <dt>Scope</dt>
                <dd>{scope}</dd>
              </div>
              <div className="property-row">
                <dt>Memory ID</dt>
                <dd>{id}</dd>
              </div>
              <div className="property-row">
                <dt>Connections</dt>
                <dd>{related.length}</dd>
              </div>
              <div className="property-row">
                <dt>Version</dt>
                <dd>v{version}</dd>
              </div>
              <div className="property-row">
                <dt>Owner</dt>
                <dd>{ownerUserId}</dd>
              </div>
              <div className="property-row">
                <dt>Created by</dt>
                <dd>{createdByAgentId ?? "User"}</dd>
              </div>
              <div className="property-row">
                <dt>Created</dt>
                <dd>{displayDate(createdAt)}</dd>
              </div>
              <div className="property-row">
                <dt>Updated</dt>
                <dd>{displayDate(updatedAt)}</dd>
              </div>
              {related.length > 0 && (
                <div className="property-row">
                  <dt>Graph</dt>
                  <dd>
                    <button
                      type="button"
                      className="property-action"
                      onClick={() => onLocalGraph(id)}
                    >
                      Open local graph
                    </button>
                  </dd>
                </div>
              )}
            </dl>
            <div className="memory-detail-actions">
              <button type="button" className="property-action" onClick={onEdit} disabled={saving}>
                Edit memory
              </button>
              <button
                type="button"
                className="property-action property-action-danger"
                onClick={onForget}
                disabled={saving}
              >
                Forget
              </button>
            </div>
          </section>

          <RelatedMemories memories={related} onOpen={onOpen} />
        </aside>
      </div>
    </div>
  );
}
