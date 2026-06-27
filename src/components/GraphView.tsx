"use client";

import { apiCall } from "@/lib/api";
import { typeColor } from "@/lib/colors";
import type { GraphData, GraphNode, PageHit } from "@/lib/types";
import { type GraphInstance, mountGraph } from "@/lib/viz/graph";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

interface GraphViewProps {
  data: GraphData;
  focusSlug?: string;
  onOpen: (slug: string) => void;
  className?: string;
  onResetFilter?: () => void;
}

function focusSet(data: GraphData, slug?: string): Set<string> | null {
  if (!slug) return null;
  const nodeIds = new Set(data.nodes.map((node) => node.id));
  if (!nodeIds.has(slug)) return null;
  const ids = new Set([slug]);
  for (const link of data.links) {
    if (link.source === slug && nodeIds.has(link.target)) ids.add(link.target);
    if (link.target === slug && nodeIds.has(link.source)) ids.add(link.source);
  }
  return ids;
}

function FitIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d="M5.75 2.75h-3v3M10.25 2.75h3v3M5.75 13.25h-3v-3M10.25 13.25h3v-3"
        strokeLinecap="round"
      />
      <path
        d="M2.75 5.75 5.5 3M10.5 3l2.75 2.75M2.75 10.25 5.5 13M10.5 13l2.75-2.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GraphToolButton({
  children,
  label,
  onClick,
  wide = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  wide?: boolean;
}) {
  const tooltipId = useId();
  return (
    <div className="graph-tool">
      <button
        type="button"
        className={`graph-tool-button${wide ? " graph-tool-button-wide" : ""}`}
        aria-label={label}
        aria-describedby={tooltipId}
        onClick={onClick}
      >
        {children}
      </button>
      <span id={tooltipId} className="graph-tooltip" role="tooltip">
        {label}
      </span>
    </div>
  );
}

function selectedNodeSummary(data: GraphData, selectedNode: GraphNode) {
  const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
  const links = data.links.filter(
    (link) => link.source === selectedNode.id || link.target === selectedNode.id,
  );
  const incoming = links.filter((link) => link.target === selectedNode.id).length;
  const outgoing = links.filter((link) => link.source === selectedNode.id).length;
  const related = links
    .map((link) => (link.source === selectedNode.id ? link.target : link.source))
    .filter((id, index, all) => all.indexOf(id) === index)
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphNode => Boolean(node))
    .slice(0, 5);
  return { incoming, links, outgoing, related };
}

const TYPE_ORDER = ["person", "company", "product", "concept"];

function typeSort(a: string, b: string): number {
  const ai = TYPE_ORDER.indexOf(a);
  const bi = TYPE_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  return a.localeCompare(b);
}

export function GraphView({ data, focusSlug, onOpen, className, onResetFilter }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<GraphInstance | null>(null);
  const [q, setQ] = useState("");
  const [contentIds, setContentIds] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const localFocus = useMemo(() => focusSet(data, focusSlug), [data, focusSlug]);
  const legendTypes = useMemo(
    () =>
      [...new Set(data.nodes.map((node) => node.type || "other"))]
        .sort(typeSort)
        .map((type) => ({ type, color: typeColor(type) })),
    [data.nodes],
  );
  const selectedNode = useMemo(
    () => data.nodes.find((node) => node.id === selectedId) ?? null,
    [data.nodes, selectedId],
  );
  const selectedSummary = useMemo(
    () => (selectedNode ? selectedNodeSummary(data, selectedNode) : null),
    [data, selectedNode],
  );
  const hasQuery = q.trim().length > 0;
  const hasResettableFocus = Boolean(localFocus && onResetFilter);
  const hasActiveFilter =
    hasQuery || hasResettableFocus || Boolean(selectedNode) || Boolean(typeFilter);
  const handleSelect = useCallback((slug: string | null) => setSelectedId(slug), []);

  // Clear the selection on an empty-canvas click or Escape. Native listeners (not
  // a JSX onClick) so the canvas stays a non-interactive element for a11y; node
  // clicks stopPropagation in the d3 layer so they never reach this container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".graph-node-preview, .graph-controls, .graph-search, .glegend")) return;
      setSelectedId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    el.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data.nodes.length) return;
    const instance = mountGraph(el, data, { onSelect: handleSelect });
    instanceRef.current = instance;
    instance.select(selectedIdRef.current);
    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
  }, [data, handleSelect]);

  useEffect(() => {
    if (!selectedId) return;
    if (data.nodes.some((node) => node.id === selectedId)) return;
    setSelectedId(null);
  }, [data.nodes, selectedId]);

  // Content search (gbrain hybrid `search`), debounced → slugs that are graph nodes.
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setContentIds(new Set());
      return;
    }
    const nodeIds = new Set(data.nodes.map((n) => n.id));
    const t = setTimeout(async () => {
      try {
        // Top hits only — the weak-semantic tail would light up half the graph.
        const hits = (await apiCall("search", { query, limit: 12 })) as PageHit[];
        const ids = (Array.isArray(hits) ? hits : [])
          .map((h) => h.slug)
          .filter((s) => nodeIds.has(s));
        setContentIds(new Set(ids));
      } catch {
        setContentIds(new Set());
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, data.nodes]);

  // Highlight set = (title ∪ content search, or focus) ∩ the legend type filter.
  // null means "everything lit". Search/focus/type-filter all feed one highlight.
  useEffect(() => {
    const query = q.trim().toLowerCase();
    let base: Set<string> | null;
    if (query) {
      base = new Set(contentIds);
      for (const n of data.nodes) if (n.label?.toLowerCase().includes(query)) base.add(n.id);
    } else {
      base = localFocus;
    }
    if (typeFilter) {
      const ofType = data.nodes.filter((n) => n.type === typeFilter).map((n) => n.id);
      base = base ? new Set(ofType.filter((id) => base?.has(id))) : new Set(ofType);
    }
    instanceRef.current?.highlight(base);
  }, [q, contentIds, data.nodes, localFocus, typeFilter]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    instanceRef.current?.select(selectedId);
  }, [selectedId]);

  function resetFilter() {
    setQ("");
    setContentIds(new Set());
    setTypeFilter(null);
    setSelectedId(null);
    onResetFilter?.();
  }

  return (
    <div ref={containerRef} className={`graph-fullscreen${className ? ` ${className}` : ""}`}>
      <div className={`glegend${typeFilter ? " glegend-filtering" : ""}`}>
        {legendTypes.map(({ type, color }) => (
          <button
            key={type}
            type="button"
            className="glegend-item"
            aria-pressed={typeFilter === type}
            title={typeFilter === type ? `Show all (clear ${type} filter)` : `Filter to ${type}`}
            onClick={() => setTypeFilter((cur) => (cur === type ? null : type))}
          >
            <span className="dot" style={{ background: color }} />
            {type}
          </button>
        ))}
      </div>
      <input
        className="graph-search"
        placeholder="Search title + content…"
        value={q}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="graph-controls">
        {hasActiveFilter && (
          <button type="button" className="graph-reset" onClick={resetFilter}>
            Reset filter
          </button>
        )}
        <div className="graph-zoom-controls" aria-label="Graph zoom controls">
          <GraphToolButton label="Zoom in" onClick={() => instanceRef.current?.zoomIn()}>
            +
          </GraphToolButton>
          <GraphToolButton label="Zoom out" onClick={() => instanceRef.current?.zoomOut()}>
            -
          </GraphToolButton>
          <GraphToolButton
            label="Reset zoom to 100%"
            onClick={() => instanceRef.current?.resetZoom()}
            wide
          >
            100%
          </GraphToolButton>
          <GraphToolButton label="Fit graph to view" onClick={() => instanceRef.current?.fit()}>
            <FitIcon />
          </GraphToolButton>
        </div>
      </div>
      {selectedNode && selectedSummary && (
        <aside key={selectedNode.id} className="graph-node-preview" aria-live="polite">
          <div className="graph-node-preview-head">
            <span className="type-badge">{selectedNode.type}</span>
            <span className="graph-node-preview-count">{selectedSummary.links.length} links</span>
          </div>
          <h2 className="graph-node-preview-title">{selectedNode.label}</h2>
          <div className="graph-node-preview-slug">{selectedNode.id}</div>
          <div className="graph-node-preview-stats">
            <span>{selectedSummary.incoming} in</span>
            <span>{selectedSummary.outgoing} out</span>
          </div>
          {selectedSummary.related.length > 0 && (
            <div className="graph-node-preview-related">
              {selectedSummary.related.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className="graph-node-preview-related-item"
                  onClick={() => setSelectedId(node.id)}
                  title={`Jump to ${node.label}`}
                >
                  {node.label}
                </button>
              ))}
            </div>
          )}
          <div className="graph-node-preview-actions">
            <button
              type="button"
              className="graph-preview-primary"
              onClick={() => onOpen(selectedNode.id)}
            >
              Open memory
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
