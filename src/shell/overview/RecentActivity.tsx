"use client";

import type { Memory } from "@corespeed/lore-sdk";
import {
  memoryConfiguredType,
  memoryTitle,
  shortMemoryDate,
} from "@/modules/memories/browser/presentation";

interface RecentActivityProps {
  items: Memory[];
  // Shown instead of the rows while the browse read is loading or failed, so an
  // unknown list never reads as "Nothing recent."
  notice?: string | null;
  onOpen: (memoryId: string) => void;
}

export function RecentActivity({ items, notice, onOpen }: RecentActivityProps) {
  return (
    <div className="panel-card">
      <p className="panel-card-title">Recent activity</p>
      {notice ? (
        <p className="panel-empty">{notice}</p>
      ) : items.length === 0 ? (
        <p className="panel-empty">Nothing recent.</p>
      ) : (
        items.map((memory) => {
          const source = memory.metadata.source;
          const type = memoryConfiguredType(memory);
          return (
            <button
              key={memory.id}
              type="button"
              className="activity-row"
              onClick={() => onOpen(memory.id)}
            >
              <span className="activity-title">{memoryTitle(memory)}</span>
              {type && <span className="badge">{type}</span>}
              <span className="memory-scope">{memory.scope}</span>
              {typeof source === "string" && source.trim() && (
                <span className="activity-src">{source}</span>
              )}
              <span className="activity-date">{shortMemoryDate(memory.updatedAt)}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
