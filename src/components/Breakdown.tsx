"use client";

interface BreakdownProps {
  byCounts: { person: number; company: number; product: number; concept: number };
  total: number;
}

const TYPES: { key: keyof BreakdownProps["byCounts"]; color: string }[] = [
  { key: "concept", color: "#8e8b82" },
  { key: "product", color: "#5db8a6" },
  { key: "person", color: "#e8a55a" },
  { key: "company", color: "#cc785c" },
];

export function Breakdown({ byCounts, total }: BreakdownProps) {
  const max = Math.max(...Object.values(byCounts), 1);

  return (
    <div className="panel-card">
      <p className="panel-card-title">By type</p>
      {TYPES.map(({ key, color }) => (
        <div key={key} className="type-bar-row">
          <span className="type-bar-label">{key}</span>
          <div className="type-bar-track">
            <div
              className="type-bar-fill"
              style={{
                width: `${(byCounts[key] / max) * 100}%`,
                background: color,
              }}
            />
          </div>
          <span className="type-bar-count">{byCounts[key]}</span>
        </div>
      ))}
    </div>
  );
}
