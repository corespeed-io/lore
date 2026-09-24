"use client";

import { typeLabel, typeSort } from "@/modules/memories/browser/presentation";
import { typeColor } from "@/shared/ui/colors";

interface BreakdownProps {
  byCounts: Record<string, number>;
  // Shown instead of the bars while the browse read is loading or failed.
  notice?: string | null;
  onType: (type: string) => void;
}

export function Breakdown({ byCounts, notice, onType }: BreakdownProps) {
  const entries = Object.entries(byCounts)
    .filter(([, count]) => count > 0)
    .sort(([a, av], [b, bv]) => {
      if (bv !== av) return bv - av;
      return typeSort(a, b);
    });
  const max = Math.max(...Object.values(byCounts), 1);

  return (
    <div className="panel-card">
      <p className="panel-card-title">By type</p>
      {notice && <p className="panel-empty">{notice}</p>}
      {!notice && entries.length === 0 && <p className="panel-empty">No typed memories.</p>}
      {entries.map(([key, count]) => (
        <button
          key={key}
          type="button"
          className="type-bar-row bar-btn"
          onClick={() => onType(key)}
          title={`Browse ${key} memories`}
        >
          <span className="dot" style={{ background: typeColor(key) }} />
          <span className="type-bar-label">{typeLabel(key)}</span>
          <div className="type-bar-track">
            <div className="type-bar-fill" style={{ width: `${(count / max) * 100}%` }} />
          </div>
          <span className="type-bar-count">{count}</span>
        </button>
      ))}
    </div>
  );
}
