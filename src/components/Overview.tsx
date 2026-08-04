"use client";

import { ActivityChart } from "@/components/ActivityChart";
import { Breakdown } from "@/components/Breakdown";
import { ConnectionHealth } from "@/components/ConnectionHealth";
import { GraphHealth } from "@/components/GraphHealth";
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
  graphData: GraphData;
  // Non-null when /api/graph failed: link stats are unknown, not zero.
  graphError?: string | null;
  allPages: PageHit[];
  onOpen: (slug: string) => void;
  onType: (type: string) => void;
  onNavigate: (tab: "overview" | "graph" | "search") => void;
}

function countByType(items: Array<{ type?: string }>) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const type = item.type?.trim() || "other";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

// Module-level, on purpose: the keyed view container remounts Overview on every
// visit to the tab, and refetching from zero made Sources / Recent Activity
// render EMPTY and pop in a second later — four brain calls and a flicker per
// tab switch, for data that rarely changes within a session. The last answer is
// painted immediately; the refresh still runs behind it and repaints on change.
let sourcesCache: SourceInfo[] = [];
let salientCache: SalientPage[] = [];
// Stamped at REQUEST time, not resolve time, so StrictMode's double-invoked
// dev effect (and any two rapid visits) cannot both slip past the check.
let dashFetchedAt = 0;
const DASH_TTL_MS = 60_000;

export function Overview({
  appTitle,
  appSubtitle,
  graphData,
  graphError,
  allPages,
  onOpen,
  onType,
  onNavigate,
}: OverviewProps) {
  const byCounts = countByType(allPages.length ? allPages : graphData.nodes);
  const linksUnknown = Boolean(graphError) && graphData.links.length === 0;
  const [sources, setSources] = useState<SourceInfo[]>(sourcesCache);
  const [salient, setSalient] = useState<SalientPage[]>(salientCache);
  const visibleSlugs = new Set(allPages.map((p) => p.slug));
  const recentItems = (
    visibleSlugs.size ? salient.filter((p) => visibleSlugs.has(p.slug)) : salient
  ).slice(0, 5);

  useEffect(() => {
    if (Date.now() - dashFetchedAt < DASH_TTL_MS) return;
    dashFetchedAt = Date.now();
    // (Unlike GraphHealth there is no live-flag early return here — both
    // .then handlers always write their cache — so request-time stamping
    // cannot strand an empty cache behind the TTL.)
    apiCall("sources_list")
      .then((d) => {
        const list = ((d as { sources?: SourceInfo[] })?.sources ?? []).filter(
          (s) => s.page_count > 0,
        );
        sourcesCache = list.sort((a, b) => b.page_count - a.page_count);
        setSources(sourcesCache);
      })
      .catch(() => {});
    apiCall("get_recent_salience", { days: 30, limit: 10 })
      .then((d) => {
        salientCache = Array.isArray(d) ? (d as SalientPage[]) : [];
        setSalient(salientCache);
      })
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

      <div className="overview-summary">
        <div className="stat-row">
          <StatCards
            pageCount={allPages.length}
            linkCount={linksUnknown ? "—" : graphData.links.length}
            sourceCount={sources.length}
            onNavigate={onNavigate}
          />
        </div>
      </div>

      <ActivityChart pages={allPages} />

      <div className="panel-grid">
        <Breakdown byCounts={byCounts} onType={onType} />
        <TopHubs
          nodes={graphData.nodes}
          links={graphData.links}
          unavailable={linksUnknown}
          onOpen={onOpen}
        />
        <Sources sources={sources} />
        <RecentActivity items={recentItems} onOpen={onOpen} />
        <GraphHealth onOpen={onOpen} />
      </div>

      <p className="section-eyebrow">Observability</p>
      <div className="panel-grid">
        <ConnectionHealth />
        <RecentRequests />
      </div>
    </div>
  );
}
