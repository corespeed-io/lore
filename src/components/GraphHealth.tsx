"use client";

import type { GraphData } from "@/lib/types";
import { degrees } from "@/lib/viz/graph";

const SHOW = 5;

export function GraphHealth({
  data,
  onOpen,
}: {
  data: GraphData;
  onOpen: (memoryId: string) => void;
}) {
  const degree = degrees(data.links);
  const isolated = data.nodes.filter((node) => (degree[node.id] ?? 0) === 0);
  if (!isolated.length) return null;

  return (
    <div className="panel-card">
      <p className="panel-card-title">Graph health</p>
      <p className="graph-health-line">
        <strong>{isolated.length}</strong> {isolated.length === 1 ? "Memory has" : "Memories have"}{" "}
        no derived affinity links
      </p>
      <ul className="graph-health-list">
        {isolated.slice(0, SHOW).map((node) => (
          <li key={node.id}>
            <button type="button" className="graph-health-src" onClick={() => onOpen(node.id)}>
              {node.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
