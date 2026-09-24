"use client";

type Tab = "overview" | "graph" | "search";

// Display strings from `displayCount`: "—" while a read is unknown and "N+" when
// a bounded read window may hide more, so an unknown count never renders as 0.
interface StatCardsProps {
  memoryCount: string;
  linkCount: string;
  sourceCount: string;
  onNavigate: (tab: Tab) => void;
}

export function StatCards({ memoryCount, linkCount, sourceCount, onNavigate }: StatCardsProps) {
  const cards: { label: string; value: string; target: Tab }[] = [
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
