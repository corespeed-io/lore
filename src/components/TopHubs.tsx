"use client";

import type { GraphData } from "@/lib/types";
import { degrees } from "@/lib/viz/graph";

interface TopHubsProps {
  nodes: GraphData["nodes"];
  links: GraphData["links"];
  onOpen: (slug: string) => void;
}

export function TopHubs({ nodes, links, onOpen }: TopHubsProps) {
  const deg = degrees(links);
  const hubs = [...nodes]
    .filter((n) => (deg[n.id] ?? 0) > 0)
    .sort((a, b) => (deg[b.id] ?? 0) - (deg[a.id] ?? 0))
    .slice(0, 5);

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
        <p style={{ color: "var(--muted-soft)", fontSize: "13px", margin: 0 }}>
          No connected nodes yet.
        </p>
      )}
    </div>
  );
}
