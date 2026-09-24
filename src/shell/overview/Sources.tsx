"use client";

import { displayCount } from "@/shared/browser/read-state";

export interface MemorySourceSummary {
  id: string;
  name: string;
  memoryCount: number;
}

interface SourcesProps {
  sources: MemorySourceSummary[];
  // Shown instead of the bars while the browse read is loading or failed.
  notice?: string | null;
  // The browse window is still filling or stopped at its cap: counts are lower bounds.
  lowerBound?: boolean;
}

export function Sources({ sources, notice, lowerBound = false }: SourcesProps) {
  const max = Math.max(...sources.map((source) => source.memoryCount), 1);

  return (
    <div className="panel-card">
      <p className="panel-card-title">Sources</p>
      {notice ? (
        <p className="panel-empty">{notice}</p>
      ) : sources.length === 0 ? (
        <p className="panel-empty">No source metadata yet.</p>
      ) : (
        sources.map((source) => (
          <div key={source.id} className="type-bar-row">
            <span className="type-bar-label" title={source.name}>
              {source.name}
            </span>
            <div className="type-bar-track">
              <div
                className="type-bar-fill type-bar-fill-primary"
                style={{ width: `${(source.memoryCount / max) * 100}%` }}
              />
            </div>
            <span className="type-bar-count">
              {displayCount(source.memoryCount, "ready", lowerBound)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
