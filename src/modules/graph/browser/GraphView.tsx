"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type GraphLegendFilter,
  graphLegend,
  graphNodeConfiguredType,
  isGraphLegendFilter,
  matchesGraphLegendFilter,
} from "@/modules/graph/browser/legend";
import type { GraphInstance } from "@/modules/graph/browser/rendering/graph";
import type { GraphData, GraphNode } from "@/modules/graph/browser/types";
import { WorkerCanvasGraph } from "@/modules/graph/browser/WorkerCanvasGraph";
import { useLoreSearch } from "@/modules/memories/browser/data";

interface GraphViewProps {
  workspaceId: string;
  active?: boolean;
  data: GraphData;
  focusId?: string;
  onOpen: (memoryId: string) => void;
  className?: string;
  onResetFilter?: () => void;
}

function focusSet(data: GraphData, memoryId?: string): Set<string> | null {
  if (!memoryId) return null;
  const nodeIds = new Set(data.nodes.map((node) => node.id));
  if (!nodeIds.has(memoryId)) return null;
  const ids = new Set([memoryId]);
  for (const link of data.links) {
    if (link.source === memoryId && nodeIds.has(link.target)) ids.add(link.target);
    if (link.target === memoryId && nodeIds.has(link.source)) ids.add(link.source);
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

export function GraphView({
  workspaceId,
  active = true,
  data,
  focusId,
  onOpen,
  className,
  onResetFilter,
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<GraphInstance | null>(null);
  const [q, setQ] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [legendFilter, setLegendFilter] = useState<GraphLegendFilter | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const localFocus = useMemo(() => focusSet(data, focusId), [data, focusId]);
  const legend = useMemo(() => graphLegend(data.nodes), [data.nodes]);
  const selectedNode = useMemo(
    () => data.nodes.find((node) => node.id === selectedId) ?? null,
    [data.nodes, selectedId],
  );
  const selectedSummary = useMemo(
    () => (selectedNode ? selectedNodeSummary(data, selectedNode) : null),
    [data, selectedNode],
  );
  const selectedType = selectedNode ? graphNodeConfiguredType(selectedNode) : null;
  const normalizedQuery = q.trim();
  const { data: contentResults = [] } = useLoreSearch(
    active && normalizedQuery === debouncedQuery ? workspaceId : "",
    debouncedQuery,
    12,
  );
  const contentIds = useMemo(() => {
    if (!normalizedQuery || normalizedQuery !== debouncedQuery) return new Set<string>();
    const nodeIds = new Set(data.nodes.map((node) => node.id));
    return new Set(
      contentResults.map((result) => result.memory.id).filter((memoryId) => nodeIds.has(memoryId)),
    );
  }, [contentResults, data.nodes, debouncedQuery, normalizedQuery]);
  const hasQuery = normalizedQuery.length > 0;
  const hasResettableFocus = Boolean(localFocus && onResetFilter);
  const hasActiveFilter =
    hasQuery || hasResettableFocus || Boolean(selectedNode) || Boolean(legendFilter);
  const handleSelect = useCallback((memoryId: string | null) => setSelectedId(memoryId), []);
  const registerGraphInstance = useCallback((instance: GraphInstance | null) => {
    instanceRef.current = instance;
    instance?.select(selectedIdRef.current);
  }, []);

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
    if (!selectedId) return;
    if (data.nodes.some((node) => node.id === selectedId)) return;
    setSelectedId(null);
  }, [data.nodes, selectedId]);

  // Workspace-scoped hybrid recall. The debounced value becomes the SWR cache
  // key, so overlapping searches are deduplicated and stale responses cannot
  // write into the next query's state.
  useEffect(() => {
    if (!active) return;
    if (!normalizedQuery) {
      setDebouncedQuery("");
      return;
    }
    const timeout = window.setTimeout(() => setDebouncedQuery(normalizedQuery), 250);
    return () => window.clearTimeout(timeout);
  }, [active, normalizedQuery]);

  // Highlight set = (title ∪ content search, or focus) ∩ the legend type/scope
  // filter. null means "everything lit". Search/focus/legend all feed one highlight.
  useEffect(() => {
    const query = q.trim().toLowerCase();
    let base: Set<string> | null;
    if (query) {
      base = new Set(contentIds);
      for (const n of data.nodes) if (n.label?.toLowerCase().includes(query)) base.add(n.id);
    } else {
      base = localFocus;
    }
    if (legendFilter) {
      const matching = data.nodes
        .filter((n) => matchesGraphLegendFilter(n, legendFilter))
        .map((n) => n.id);
      base = base ? new Set(matching.filter((id) => base?.has(id))) : new Set(matching);
    }
    instanceRef.current?.highlight(base);
  }, [q, contentIds, data.nodes, localFocus, legendFilter]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    instanceRef.current?.select(selectedId);
  }, [selectedId]);

  function resetFilter() {
    setQ("");
    setLegendFilter(null);
    setSelectedId(null);
    onResetFilter?.();
  }

  return (
    <div ref={containerRef} className={`graph-fullscreen${className ? ` ${className}` : ""}`}>
      <WorkerCanvasGraph
        data={data}
        onSelect={handleSelect}
        registerGraphInstance={registerGraphInstance}
        production
        showMetrics={false}
      />
      <div className={`glegend${legendFilter ? " glegend-filtering" : ""}`}>
        {legend.types.map(({ type, color }) => {
          const pressed = isGraphLegendFilter(legendFilter, "type", type);
          return (
            <button
              key={`type:${type}`}
              type="button"
              className="glegend-item"
              aria-pressed={pressed}
              title={pressed ? `Show all (clear ${type} filter)` : `Filter to ${type}`}
              onClick={() => setLegendFilter(pressed ? null : { kind: "type", value: type })}
            >
              <span className="dot" style={{ background: color }} />
              {type}
            </button>
          );
        })}
        {legend.scopes.length > 0 && <span className="glegend-label">scope</span>}
        {legend.scopes.map(({ scope, count }) => {
          const pressed = isGraphLegendFilter(legendFilter, "scope", scope);
          return (
            <button
              key={`scope:${scope}`}
              type="button"
              className="glegend-item"
              aria-pressed={pressed}
              title={
                pressed ? `Show all (clear ${scope} scope filter)` : `Filter to ${scope} Memories`
              }
              onClick={() => setLegendFilter(pressed ? null : { kind: "scope", value: scope })}
            >
              {scope} {count}
            </button>
          );
        })}
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
        <fieldset className="graph-zoom-controls" aria-label="Graph zoom controls">
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
        </fieldset>
      </div>
      {selectedNode && selectedSummary && (
        <aside key={selectedNode.id} className="graph-node-preview" aria-live="polite">
          <div className="graph-node-preview-head">
            {selectedType && <span className="type-badge">{selectedType}</span>}
            <span className="graph-node-preview-count">
              {selectedNode.scope} · {selectedSummary.links.length} links
            </span>
          </div>
          <h2 className="graph-node-preview-title">{selectedNode.label}</h2>
          <div className="graph-node-preview-id">{selectedNode.id}</div>
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
