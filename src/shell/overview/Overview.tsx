"use client";

import type { Memory } from "@corespeed/lore-sdk";
import { GraphHealth } from "@/modules/graph/browser/GraphHealth";
import { TopHubs } from "@/modules/graph/browser/TopHubs";
import type { GraphData } from "@/modules/graph/browser/types";
import { memoryType } from "@/modules/memories/browser/presentation";
import { ActivityChart } from "@/shell/overview/ActivityChart";
import { Breakdown } from "@/shell/overview/Breakdown";
import { ConnectionHealth } from "@/shell/overview/ConnectionHealth";
import { RecentActivity } from "@/shell/overview/RecentActivity";
import { RecentRequests } from "@/shell/overview/RecentRequests";
import { type MemorySourceSummary, Sources } from "@/shell/overview/Sources";
import { StatCards } from "@/shell/overview/StatCards";

interface OverviewProps {
  appTitle: string;
  appSubtitle: string;
  workspaceName: string;
  graphData: GraphData;
  graphError?: string | null;
  memories: Memory[];
  onOpen: (memoryId: string) => void;
  onType: (type: string) => void;
  onNavigate: (tab: "overview" | "graph" | "search") => void;
}

function countByType(memories: Memory[]) {
  const counts = Object.create(null) as Record<string, number>;
  for (const memory of memories) {
    const type = memoryType(memory);
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function memorySources(memories: Memory[]): MemorySourceSummary[] {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    const source = memory.metadata.source;
    if (typeof source !== "string" || !source.trim()) continue;
    const name = source.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, memoryCount]) => ({ id: name, name, memoryCount }))
    .sort(
      (left, right) => right.memoryCount - left.memoryCount || left.name.localeCompare(right.name),
    );
}

export function Overview({
  appTitle,
  appSubtitle,
  workspaceName,
  graphData,
  graphError,
  memories,
  onOpen,
  onType,
  onNavigate,
}: OverviewProps) {
  const linksUnknown = Boolean(graphError) && graphData.links.length === 0;
  const sources = memorySources(memories);

  return (
    <div className="page-wrap">
      <div className="hero">
        <div className="hero-mesh" />
        <div className="hero-inner">
          <p className="hero-eyebrow">{workspaceName} workspace</p>
          <h1 className="hero-title">{appTitle}</h1>
          {appSubtitle && <p className="hero-sub">{appSubtitle}</p>}
        </div>
      </div>

      <div className="overview-summary">
        <div className="stat-row">
          <StatCards
            memoryCount={memories.length}
            linkCount={linksUnknown ? "—" : graphData.links.length}
            sourceCount={sources.length}
            onNavigate={onNavigate}
          />
        </div>
      </div>

      <ActivityChart memories={memories} />

      <div className="panel-grid">
        <Breakdown byCounts={countByType(memories)} onType={onType} />
        <TopHubs
          nodes={graphData.nodes}
          links={graphData.links}
          unavailable={linksUnknown}
          onOpen={onOpen}
        />
        <Sources sources={sources} />
        <RecentActivity items={memories.slice(0, 5)} onOpen={onOpen} />
        <GraphHealth data={graphData} onOpen={onOpen} />
      </div>

      <p className="section-eyebrow">Observability</p>
      <div className="panel-grid">
        <ConnectionHealth />
        <RecentRequests />
      </div>
    </div>
  );
}
