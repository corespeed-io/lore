"use client";

import type { Memory } from "@corespeed/lore-sdk";
import { GraphHealth } from "@/modules/graph/browser/GraphHealth";
import { TopHubs } from "@/modules/graph/browser/TopHubs";
import { type GraphData, isGraphCapped } from "@/modules/graph/browser/types";
import { memoryType } from "@/modules/memories/browser/presentation";
import type { ReadState } from "@/shared/browser/read-state";
import { ActivityChart } from "@/shell/overview/ActivityChart";
import { Breakdown } from "@/shell/overview/Breakdown";
import { ConnectionHealth } from "@/shell/overview/ConnectionHealth";
import { memoryPanelNotice, overviewStats } from "@/shell/overview/presentation";
import { RecentActivity } from "@/shell/overview/RecentActivity";
import { RecentRequests } from "@/shell/overview/RecentRequests";
import { type MemorySourceSummary, Sources } from "@/shell/overview/Sources";
import { StatCards } from "@/shell/overview/StatCards";

interface OverviewProps {
  appTitle: string;
  appSubtitle: string;
  workspaceName: string;
  graphData: GraphData;
  graphState: ReadState;
  memories: Memory[];
  memoriesState: ReadState;
  /** False while browse is still filling pages or has stopped at its 5,000 cap. */
  memoriesComplete: boolean;
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
  graphState,
  memories,
  memoriesState,
  memoriesComplete,
  onOpen,
  onType,
  onNavigate,
}: OverviewProps) {
  const sources = memorySources(memories);
  const stats = overviewStats({
    memoryCount: memories.length,
    sourceCount: sources.length,
    memoriesState,
    memoriesComplete,
    linkCount: graphData.links.length,
    graphState,
    graphCapped: isGraphCapped(graphData),
  });
  const memoryNotice = memoryPanelNotice(memoriesState);

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
            memoryCount={stats.memories}
            linkCount={stats.links}
            sourceCount={stats.sources}
            onNavigate={onNavigate}
          />
        </div>
      </div>

      <ActivityChart memories={memories} />

      <div className="panel-grid">
        <Breakdown byCounts={countByType(memories)} notice={memoryNotice} onType={onType} />
        <TopHubs
          nodes={graphData.nodes}
          links={graphData.links}
          state={graphState}
          onOpen={onOpen}
        />
        <Sources sources={sources} notice={memoryNotice} />
        <RecentActivity items={memories.slice(0, 5)} notice={memoryNotice} onOpen={onOpen} />
        {graphState === "ready" && <GraphHealth data={graphData} onOpen={onOpen} />}
      </div>

      <p className="section-eyebrow">Observability</p>
      <div className="panel-grid">
        <ConnectionHealth />
        <RecentRequests />
      </div>
    </div>
  );
}
