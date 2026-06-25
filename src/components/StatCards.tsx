"use client";

interface StatCardsProps {
  nodeCount: number;
  linkCount: number;
  byCounts: { person: number; company: number; product: number; concept: number };
}

const TYPE_COLORS: Record<string, string> = {
  person: "#e8a55a",
  company: "#cc785c",
  product: "#5db8a6",
  concept: "#8e8b82",
};

export function StatCards({ nodeCount, linkCount, byCounts }: StatCardsProps) {
  const cards = [
    { label: "Pages", value: nodeCount, dot: null },
    { label: "Links", value: linkCount, dot: null },
    { label: "People", value: byCounts.person, dot: TYPE_COLORS.person },
    { label: "Companies", value: byCounts.company, dot: TYPE_COLORS.company },
    { label: "Products", value: byCounts.product, dot: TYPE_COLORS.product },
    { label: "Concepts", value: byCounts.concept, dot: TYPE_COLORS.concept },
  ];

  return (
    <div className="stat-cards">
      {cards.map((c) => (
        <div key={c.label} className="stat-card">
          <div className="stat-card-label">
            {c.dot && <span className="stat-card-dot" style={{ background: c.dot }} />}
            {c.label}
          </div>
          <div className="stat-card-number">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
