"use client";

type Tab = "overview" | "graph" | "search";

interface StatCardsProps {
  pageCount: number;
  linkCount: number;
  sourceCount: number;
  onNavigate: (tab: Tab) => void;
}

export function StatCards({ pageCount, linkCount, sourceCount, onNavigate }: StatCardsProps) {
  const cards: { label: string; value: number; target: Tab }[] = [
    { label: "Pages", value: pageCount, target: "search" },
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
