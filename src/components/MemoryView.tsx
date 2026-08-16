"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  type CodeEvidenceRow,
  type CodeEvidenceSummary,
  shortCommitOid,
  summarizeCodeEvidence,
} from "@/lib/code-evidence-view";
import { useLoreMemoryCodeEvidence } from "@/lib/lore-swr";
import { renderMarkdown } from "@/lib/markdown";
import type { MemoryScope } from "@/lib/types";

interface MemoryLink {
  id: string;
  label: string;
}

interface MemoryViewProps {
  workspaceId: string;
  title: string;
  type: string;
  id: string;
  body: string;
  wikilinkTargets: Readonly<Record<string, string>>;
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

function CodeCitation({ row }: { row: CodeEvidenceRow }) {
  return (
    <li className="code-evidence-item">
      <div className="code-evidence-header">
        <span className={`type-badge code-evidence-state-${row.tone}`}>{row.stateLabel}</span>
        <span className="code-evidence-relationship">{row.relationship}</span>
      </div>
      <span className="code-evidence-locator">{row.locator}</span>
      <p className="code-evidence-state-description">{row.stateDescription}</p>
      <dl className="property-list">
        <div className="property-row">
          <dt>Cited</dt>
          <dd>{shortCommitOid(row.citedCommitOid)}</dd>
        </div>
        {row.declarationChunkOrdinal !== null && (
          <div className="property-row">
            <dt>Chunk</dt>
            <dd>{row.declarationChunkOrdinal}</dd>
          </div>
        )}
        {row.movedToPath && (
          <div className="property-row">
            <dt>Now at</dt>
            <dd>{row.movedToPath}</dd>
          </div>
        )}
        {row.validatedCommitOid && (
          <div className="property-row">
            <dt>Against</dt>
            <dd>{shortCommitOid(row.validatedCommitOid)}</dd>
          </div>
        )}
        <div className="property-row">
          <dt>Checked</dt>
          <dd>{displayDate(row.validatedAt)}</dd>
        </div>
      </dl>
      <p className="code-evidence-relationship-description">{row.relationshipDescription}</p>
    </li>
  );
}

function CodeCitations({
  summary,
  isLoading,
  hasError,
}: {
  summary: CodeEvidenceSummary;
  isLoading: boolean;
  hasError: boolean;
}) {
  return (
    <section className="context-section">
      <div className="context-heading">
        <h3>Code citations</h3>
        <span>{hasError || isLoading ? "—" : summary.total}</span>
      </div>
      {isLoading ? (
        <p className="context-empty">Loading code citations…</p>
      ) : hasError ? (
        <p className="context-empty">Code citations could not be loaded.</p>
      ) : summary.total === 0 ? (
        <p className="context-empty">No code citations</p>
      ) : (
        <>
          <ul className="code-evidence-list">
            {summary.rows.map((row) => (
              <CodeCitation key={row.id} row={row} />
            ))}
          </ul>
          <p className="code-evidence-footnote">
            Lore validates each anchor against the code it cited; it never rewrites the Memory.
          </p>
        </>
      )}
    </section>
  );
}

export function MemoryView({
  workspaceId,
  title,
  type,
  id,
  body,
  wikilinkTargets,
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
  const bodyHtml = useMemo(
    () => renderMarkdown(body.replace(/^#\s+.*\r?\n+/, ""), wikilinkTargets),
    [body, wikilinkTargets],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const codeEvidence = useLoreMemoryCodeEvidence(workspaceId, id);
  const codeEvidenceSummary = useMemo(
    () => summarizeCodeEvidence(codeEvidence.data ?? []),
    [codeEvidence.data],
  );

  useEffect(() => {
    const bodyElement = bodyRef.current;
    if (!bodyElement) return;
    bodyElement.innerHTML = bodyHtml;
    const handleClick = (event: globalThis.MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a.wl[data-memory-id]");
      const memoryId = anchor?.dataset.memoryId;
      if (!memoryId) return;
      event.preventDefault();
      onOpen(memoryId);
    };
    bodyElement.addEventListener("click", handleClick);
    return () => bodyElement.removeEventListener("click", handleClick);
  }, [bodyHtml, onOpen]);

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
          {codeEvidenceSummary.attentionMessage && (
            <p className="code-evidence-notice" role="status">
              {codeEvidenceSummary.attentionMessage}
            </p>
          )}
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

          <CodeCitations
            summary={codeEvidenceSummary}
            isLoading={!codeEvidence.data && !codeEvidence.error}
            hasError={Boolean(codeEvidence.error)}
          />

          <RelatedMemories memories={related} onOpen={onOpen} />
        </aside>
      </div>
    </div>
  );
}
