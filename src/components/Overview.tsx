"use client";

import { ActivityChart } from "@/components/ActivityChart";
import { Breakdown } from "@/components/Breakdown";
import { ConnectionHealth } from "@/components/ConnectionHealth";
import { RecentActivity } from "@/components/RecentActivity";
import { RecentRequests } from "@/components/RecentRequests";
import { Sources } from "@/components/Sources";
import { StatCards } from "@/components/StatCards";
import { TopHubs } from "@/components/TopHubs";
import { apiCall } from "@/lib/api";
import type { GraphData, PageHit, SalientPage, SourceInfo } from "@/lib/types";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

interface OverviewProps {
  appTitle: string;
  appSubtitle: string;
  adminSummary?: ReactNode;
  graphData: GraphData;
  allPages: PageHit[];
  onOpen: (slug: string) => void;
  onType: (type: string) => void;
  onNavigate: (tab: "overview" | "graph" | "search") => void;
}

function countByType(nodes: GraphData["nodes"]) {
  const counts = { person: 0, company: 0, product: 0, concept: 0 };
  for (const n of nodes) {
    const t = n.type as keyof typeof counts;
    if (t in counts) counts[t]++;
  }
  return counts;
}

export function Overview({
  appTitle,
  appSubtitle,
  adminSummary,
  graphData,
  allPages,
  onOpen,
  onType,
  onNavigate,
}: OverviewProps) {
  const byCounts = countByType(graphData.nodes);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [salient, setSalient] = useState<SalientPage[]>([]);

  useEffect(() => {
    apiCall("sources_list")
      .then((d) => {
        const list = ((d as { sources?: SourceInfo[] })?.sources ?? []).filter(
          (s) => s.page_count > 0,
        );
        setSources(list.sort((a, b) => b.page_count - a.page_count));
      })
      .catch(() => {});
    apiCall("get_recent_salience", { days: 30, limit: 5 })
      .then((d) => setSalient(Array.isArray(d) ? (d as SalientPage[]) : []))
      .catch(() => {});
  }, []);

  return (
    <div className="page-wrap">
      <div className="hero">
        <div className="hero-mesh" />
        <div className="hero-inner">
          <p className="hero-eyebrow">Team brain</p>
          <h1 className="hero-title">{appTitle}</h1>
          {appSubtitle && <p className="hero-sub">{appSubtitle}</p>}
        </div>
      </div>

      <div className={adminSummary ? "overview-summary has-admin" : "overview-summary"}>
        <div className="stat-row">
          <StatCards
            pageCount={allPages.length}
            linkCount={graphData.links.length}
            sourceCount={sources.length}
            onNavigate={onNavigate}
          />
        </div>
        {adminSummary && <div className="overview-admin-summary">{adminSummary}</div>}
      </div>

      <ActivityChart pages={allPages} />

      <div className="panel-grid">
        <Breakdown byCounts={byCounts} total={graphData.nodes.length} onType={onType} />
        <TopHubs nodes={graphData.nodes} links={graphData.links} onOpen={onOpen} />
        <Sources sources={sources} />
        <RecentActivity items={salient} onOpen={onOpen} />
      </div>

      <p className="section-eyebrow">Observability</p>
      <div className="panel-grid">
        <ConnectionHealth />
        <RecentRequests />
      </div>
    </div>
  );
}
