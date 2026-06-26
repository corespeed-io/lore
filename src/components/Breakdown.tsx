"use client";

interface BreakdownProps {
  byCounts: { person: number; company: number; product: number; concept: number };
  total: number;
  onType: (type: string) => void;
}

const TYPES: { key: keyof BreakdownProps["byCounts"]; color: string }[] = [
  { key: "concept", color: "#8f8f8f" },
  { key: "product", color: "#50e3c2" },
  { key: "person", color: "#0070f3" },
  { key: "company", color: "#7928ca" },
];

export function Breakdown({ byCounts, onType }: BreakdownProps) {
  const max = Math.max(...Object.values(byCounts), 1);

  return (
    <div className="panel-card">
      <p className="panel-card-title">By type</p>
      {TYPES.map(({ key, color }) => (
        <button
          key={key}
          type="button"
          className="type-bar-row bar-btn"
          onClick={() => onType(key)}
          title={`Browse ${key} memories`}
        >
          <span className="dot" style={{ background: color }} />
          <span className="type-bar-label">{key}</span>
          <div className="type-bar-track">
            <div className="type-bar-fill" style={{ width: `${(byCounts[key] / max) * 100}%` }} />
          </div>
          <span className="type-bar-count">{byCounts[key]}</span>
        </button>
      ))}
    </div>
  );
}
