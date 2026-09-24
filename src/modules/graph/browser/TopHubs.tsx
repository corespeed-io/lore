"use client";

import { degrees } from "@/modules/graph/browser/rendering/graph";
import type { GraphData } from "@/modules/graph/browser/types";
import type { ReadState } from "@/shared/browser/read-state";

interface TopHubsProps {
  nodes: GraphData["nodes"];
  links: GraphData["links"];
  // Until the graph read succeeds, "no hubs" is unknown, not empty.
  state: ReadState;
  onOpen: (memoryId: string) => void;
}

const UNKNOWN_HUBS: Record<Exclude<ReadState, "ready">, string> = {
  loading: "Loading graph…",
  error: "Affinity data is currently unavailable.",
};

export function TopHubs({ nodes, links, state, onOpen }: TopHubsProps) {
  const deg = degrees(links);
  const hubs =
    state === "ready"
      ? [...nodes]
          .filter((n) => (deg[n.id] ?? 0) > 0)
          .sort((a, b) => (deg[b.id] ?? 0) - (deg[a.id] ?? 0))
          .slice(0, 5)
      : [];

  return (
    <div className="panel-card">
      <p className="panel-card-title">Top hubs</p>
      {hubs.map((n) => (
        <button key={n.id} type="button" className="hub-row" onClick={() => onOpen(n.id)}>
          <span className="hub-label">{n.label}</span>
          <span className="hub-degree">{deg[n.id] ?? 0}</span>
        </button>
      ))}
      {hubs.length === 0 && (
        <p className="panel-empty">
          {state === "ready" ? "No connected nodes yet." : UNKNOWN_HUBS[state]}
        </p>
      )}
    </div>
  );
}
