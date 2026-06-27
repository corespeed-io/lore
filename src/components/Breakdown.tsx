"use client";

import { typeColor } from "@/lib/colors";

interface BreakdownProps {
  byCounts: Record<string, number>;
  onType: (type: string) => void;
}

const TYPE_ORDER = ["concept", "product", "person", "company"];

function typeLabel(type: string): string {
  return type.replace(/_/g, " ");
}

export function Breakdown({ byCounts, onType }: BreakdownProps) {
  const entries = Object.entries(byCounts)
    .filter(([, count]) => count > 0)
    .sort(([a, av], [b, bv]) => {
      if (bv !== av) return bv - av;
      const ai = TYPE_ORDER.indexOf(a);
      const bi = TYPE_ORDER.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.localeCompare(b);
    });
  const max = Math.max(...Object.values(byCounts), 1);

  return (
    <div className="panel-card">
      <p className="panel-card-title">By type</p>
      {entries.length === 0 && (
        <p style={{ color: "var(--muted-soft)", fontSize: "13px", margin: 0 }}>
          No typed memories.
        </p>
      )}
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
