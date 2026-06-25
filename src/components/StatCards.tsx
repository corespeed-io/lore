"use client";

interface StatCardsProps {
  nodeCount: number;
  linkCount: number;
}

export function StatCards({ nodeCount, linkCount }: StatCardsProps) {
  const cards = [
    { label: "Pages", value: nodeCount },
    { label: "Links", value: linkCount },
  ];

  return (
    <div className="stat-cards">
      {cards.map((c) => (
        <div key={c.label} className="stat-card">
          <div className="stat-card-label">{c.label}</div>
          <div className="stat-card-number">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
