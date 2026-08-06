"use client";

type Tab = "overview" | "graph" | "search";

interface StatCardsProps {
  memoryCount: number;
  // "—" when the graph read failed: an unknown link count must not render as 0.
  linkCount: number | string;
  sourceCount: number;
  onNavigate: (tab: Tab) => void;
}

export function StatCards({ memoryCount, linkCount, sourceCount, onNavigate }: StatCardsProps) {
  const cards: { label: string; value: number | string; target: Tab }[] = [
    { label: "Memories", value: memoryCount, target: "search" },
    { label: "Links", value: linkCount, target: "graph" },
    { label: "Sources", value: sourceCount, target: "search" },
  ];

  return (
    <div className="stat-cards">
      {cards.map((c) => (
        <button
          key={c.label}
          type="button"
          className="stat-card stat-card-btn"
          onClick={() => onNavigate(c.target)}
        >
          <div className="stat-card-label">{c.label}</div>
          <div className="stat-card-number">{c.value}</div>
        </button>
      ))}
    </div>
  );
}
