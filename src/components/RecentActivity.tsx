"use client";

import type { SalientPage } from "@/lib/types";

interface RecentActivityProps {
  items: SalientPage[];
  onOpen: (slug: string) => void;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RecentActivity({ items, onOpen }: RecentActivityProps) {
  return (
    <div className="panel-card">
      <p className="panel-card-title">Recent activity</p>
      {items.length === 0 ? (
        <p style={{ color: "var(--muted-soft)", fontSize: "13px", margin: 0 }}>Nothing recent.</p>
      ) : (
        items.map((p) => (
          <button
            key={p.slug}
            type="button"
            className="activity-row"
            onClick={() => onOpen(p.slug)}
          >
            <span className="activity-title">{p.title || p.slug}</span>
            {p.type && <span className="badge">{p.type}</span>}
            {p.source_id && <span className="activity-src">{p.source_id}</span>}
            <span className="activity-date">{shortDate(p.updated_at)}</span>
          </button>
        ))
      )}
    </div>
  );
}
