"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraph, MemoryGraphNode } from "@/lib/graph";
import { type GraphInstance, mountGraph } from "@/lib/viz/graph";
import { Button } from "./ui/button";
import { SearchIcon } from "./ui/icons";

interface MemoryGraphViewProps {
  workspaceId: string;
  workspaceName: string;
  appTitle: string;
  onOpenMemory: (memoryId: string) => Promise<void>;
}

interface GraphNodeSummary extends MemoryGraphNode {
  degree: number;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function MemoryGraphView({
  workspaceId,
  workspaceName,
  appTitle,
  onOpenMemory,
}: MemoryGraphViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<GraphInstance | null>(null);
  const [graph, setGraph] = useState<MemoryGraph>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSelectedId(null);
    fetch(`/api/graph?limit=100&r=${revision}`, {
      headers: { "x-lore-workspace-id": workspaceId },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `Graph request failed (${response.status})`);
        }
        return response.json() as Promise<MemoryGraph>;
      })
      .then((loaded) => {
        setGraph(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if ((cause as Error).name !== "AbortError") {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, workspaceId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || loading || !graph.nodes.length) return;
    const instance = mountGraph(canvas, graph, { onSelect: setSelectedId });
    instanceRef.current = instance;
    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
  }, [graph, loading]);

  useEffect(() => {
    instanceRef.current?.select(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const clearSelection = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest(".gnodes circle")) return;
      setSelectedId(null);
    };
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    canvas.addEventListener("click", clearSelection);
    window.addEventListener("keydown", clearOnEscape);
    return () => {
      canvas.removeEventListener("click", clearSelection);
      window.removeEventListener("keydown", clearOnEscape);
    };
  }, []);

  const degreeById = useMemo(() => {
    const degrees = new Map<string, number>();
    for (const link of graph.links) {
      degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
      degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
    }
    return degrees;
  }, [graph.links]);
  const nodes = useMemo<GraphNodeSummary[]>(
    () => graph.nodes.map((node) => ({ ...node, degree: degreeById.get(node.id) ?? 0 })),
    [degreeById, graph.nodes],
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedId ? (nodeById.get(selectedId) ?? null) : null;
  const related = useMemo(() => {
    if (!selected) return [];
    return graph.links
      .filter((link) => link.source === selected.id || link.target === selected.id)
      .sort((left, right) => right.weight - left.weight)
      .map((link) => ({
        link,
        node: nodeById.get(link.source === selected.id ? link.target : link.source),
      }))
      .filter((item): item is { link: MemoryGraph["links"][number]; node: GraphNodeSummary } =>
        Boolean(item.node),
      );
  }, [graph.links, nodeById, selected]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = useMemo(
    () =>
      new Set(
        nodes
          .filter(
            (node) =>
              !normalizedQuery ||
              node.label.toLocaleLowerCase().includes(normalizedQuery) ||
              node.preview.toLocaleLowerCase().includes(normalizedQuery) ||
              node.type.toLocaleLowerCase().includes(normalizedQuery),
          )
          .map((node) => node.id),
      ),
    [nodes, normalizedQuery],
  );

  useEffect(() => {
    instanceRef.current?.highlight(normalizedQuery ? matches : null);
  }, [matches, normalizedQuery]);

  return (
    <section
      className="page-wrap page-wrap-wide graph-page view-anim"
      aria-labelledby="graph-title"
    >
      <header className="page-header graph-page-header">
        <div>
          <p className="page-eyebrow">
            {workspaceName} · {appTitle}
          </p>
          <h1 id="graph-title">Graph</h1>
          <p className="page-description">
            Explore affinities across the Memories this Actor can read.
          </p>
        </div>
        <div className="graph-counts">
          <strong>{graph.nodes.length}</strong> Memories
          <span />
          <strong>{graph.links.length}</strong> affinities
        </div>
      </header>

      <div className="graph-toolbar">
        <label className="graph-search">
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a Memory in this graph…"
            aria-label="Search Graph"
          />
          {normalizedQuery && <span>{matches.size} match</span>}
        </label>
        <div className="graph-tools">
          <Button
            variant="ghost"
            aria-label="Zoom out"
            onClick={() => instanceRef.current?.zoomOut()}
          >
            −
          </Button>
          <Button
            variant="ghost"
            aria-label="Reset zoom to 100%"
            onClick={() => instanceRef.current?.resetZoom()}
          >
            100%
          </Button>
          <Button
            variant="ghost"
            aria-label="Zoom in"
            onClick={() => instanceRef.current?.zoomIn()}
          >
            +
          </Button>
          <Button variant="ghost" onClick={() => instanceRef.current?.fit()}>
            Fit
          </Button>
          <Button variant="secondary" onClick={() => setRevision((current) => current + 1)}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="inline-error graph-error" role="alert">
          <div>
            <strong>Couldn&apos;t load this Memory Graph.</strong>
            <span>{error}</span>
          </div>
          <Button variant="ghost" onClick={() => setRevision((current) => current + 1)}>
            Retry
          </Button>
        </div>
      )}

      <div className="graph-workspace">
        <div ref={canvasRef} className="graph-canvas" aria-busy={loading}>
          {loading ? (
            <div className="graph-state" aria-live="polite">
              <span className="graph-state-orbit" aria-hidden="true" />
              <p>Mapping visible Memories…</p>
            </div>
          ) : graph.nodes.length ? null : (
            <div className="graph-state">
              <span className="graph-state-orbit" aria-hidden="true" />
              <h2>No visible Memories yet.</h2>
              <p>Capture Memories first; Graph will map their affinities automatically.</p>
            </div>
          )}
        </div>

        <aside className="graph-inspector" aria-label="Graph selection">
          {selected ? (
            <>
              <div className="graph-inspector-head">
                <span>{selected.scope}</span>
                <span>{selected.degree} affinities</span>
              </div>
              <h2>{selected.label}</h2>
              <p>{selected.preview}</p>
              <dl>
                <div>
                  <dt>Updated</dt>
                  <dd>{dateLabel(selected.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>{selected.id}</dd>
                </div>
              </dl>
              {related.length > 0 && (
                <div className="graph-related">
                  <h3>Nearest Memories</h3>
                  {related.slice(0, 5).map(({ link, node }) => (
                    <button key={node.id} type="button" onClick={() => setSelectedId(node.id)}>
                      <span>{node.label}</span>
                      <small>{Math.round(link.weight * 100)}%</small>
                    </button>
                  ))}
                </div>
              )}
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await onOpenMemory(selected.id);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              >
                Open Memory
              </Button>
            </>
          ) : (
            <div className="graph-inspector-empty">
              <p className="page-eyebrow">How to read it</p>
              <h2>Each point is a Memory.</h2>
              <p>
                Lines show derived content affinity—not ownership or permission. Hover a point to
                focus its neighborhood; drag points or the canvas to explore.
              </p>
              <div className="graph-legend">
                <span>
                  <i className="graph-legend-shared" /> shared
                </span>
                <span>
                  <i className="graph-legend-private" /> private
                </span>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
