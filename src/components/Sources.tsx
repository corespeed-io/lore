"use client";

import type { MemorySourceSummary } from "@/lib/types";

interface SourcesProps {
  sources: MemorySourceSummary[];
}

export function Sources({ sources }: SourcesProps) {
  const max = Math.max(...sources.map((source) => source.memoryCount), 1);

  return (
    <div className="panel-card">
      <p className="panel-card-title">Sources</p>
      {sources.length === 0 ? (
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
            <span className="type-bar-count">{source.memoryCount}</span>
          </div>
        ))
      )}
    </div>
  );
}
