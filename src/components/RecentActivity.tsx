"use client";

import { memoryTitle, memoryType } from "@/lib/lore-api";
import type { Memory } from "@/lib/types";

interface RecentActivityProps {
  items: Memory[];
  onOpen: (memoryId: string) => void;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RecentActivity({ items, onOpen }: RecentActivityProps) {
  return (
    <div className="panel-card">
      <p className="panel-card-title">Recent activity</p>
      {items.length === 0 ? (
        <p className="panel-empty">Nothing recent.</p>
      ) : (
        items.map((memory) => {
          const source = memory.metadata.source;
          return (
            <button
              key={memory.id}
              type="button"
              className="activity-row"
              onClick={() => onOpen(memory.id)}
            >
              <span className="activity-title">{memoryTitle(memory)}</span>
              <span className="badge">{memoryType(memory)}</span>
              {typeof source === "string" && source.trim() && (
                <span className="activity-src">{source}</span>
              )}
              <span className="activity-date">{shortDate(memory.updatedAt)}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
