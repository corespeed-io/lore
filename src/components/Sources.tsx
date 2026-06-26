"use client";

import type { SourceInfo } from "@/lib/types";

interface SourcesProps {
  sources: SourceInfo[];
}

export function Sources({ sources }: SourcesProps) {
  const max = Math.max(...sources.map((s) => s.page_count), 1);

  return (
    <div className="panel-card">
      <p className="panel-card-title">Sources</p>
      {sources.length === 0 ? (
        <p style={{ color: "var(--muted-soft)", fontSize: "13px", margin: 0 }}>No sources yet.</p>
      ) : (
        sources.map((s) => (
          <div key={s.id} className="type-bar-row">
            <span className="type-bar-label" title={s.name}>
              {s.id}
            </span>
            <div className="type-bar-track">
              <div
                className="type-bar-fill"
                style={{ width: `${(s.page_count / max) * 100}%`, background: "var(--primary)" }}
              />
            </div>
            <span className="type-bar-count">{s.page_count}</span>
          </div>
        ))
      )}
    </div>
  );
}
