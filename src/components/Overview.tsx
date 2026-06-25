"use client";

import { Breakdown } from "@/components/Breakdown";
import { DetailPanel } from "@/components/DetailPanel";
import { StatCards } from "@/components/StatCards";
import { TopHubs } from "@/components/TopHubs";
import type { GraphData } from "@/lib/types";
import { mountGraph } from "@/lib/viz/graph";
import { useEffect, useRef } from "react";

interface PageState {
  title: string;
  type: string;
  slug: string;
  body: string;
  neighbors: { slug: string; title: string }[];
}

interface OverviewProps {
  graphData: GraphData;
  graphError: string | null;
  brandColors: Record<string, string>;
  detailPage: PageState | null;
  onOpen: (slug: string) => void;
}

function countByType(nodes: GraphData["nodes"]) {
  const counts = { person: 0, company: 0, product: 0, concept: 0 };
  for (const n of nodes) {
    const t = n.type as keyof typeof counts;
    if (t in counts) counts[t]++;
  }
  return counts;
}

function GraphPanelContent({
  data,
  brandColors,
  onOpen,
}: {
  data: GraphData;
  brandColors: Record<string, string>;
  onOpen: (slug: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data.nodes.length) return;
    const instance = mountGraph(el, data, { colors: brandColors, onOpen });
    return () => instance.destroy();
  }, [data, brandColors, onOpen]);

  return (
    <div ref={containerRef} className="graph-panel-body">
      <div className="glegend">
        <span>
          <span className="dot" style={{ background: "#e8a55a" }} />
          person
        </span>
        <span>
          <span className="dot" style={{ background: "#cc785c" }} />
          company
        </span>
        <span>
          <span className="dot" style={{ background: "#5db8a6" }} />
          product
        </span>
        <span>
          <span className="dot" style={{ background: "#8e8b82" }} />
          concept
        </span>
      </div>
    </div>
  );
}

export function Overview({
  graphData,
  graphError,
  brandColors,
  detailPage,
  onOpen,
}: OverviewProps) {
  const byCounts = countByType(graphData.nodes);

  return (
    <div className="page-wrap">
      <StatCards
        nodeCount={graphData.nodes.length}
        linkCount={graphData.links.length}
        byCounts={byCounts}
      />

      <div className="overview-grid">
        <div className="graph-panel">
          <div className="graph-panel-header">
            <h2 className="graph-panel-title">Knowledge graph</h2>
            <p className="graph-panel-caption">
              {graphData.nodes.length} nodes · {graphData.links.length} links · drag · hover · click
            </p>
          </div>
          {graphError ? (
            <div style={{ padding: "20px", color: "var(--on-dark-soft)" }}>
              Graph error: {graphError}
            </div>
          ) : graphData.nodes.length === 0 ? (
            <div style={{ padding: "20px", color: "var(--on-dark-soft)" }}>Loading graph…</div>
          ) : (
            <GraphPanelContent data={graphData} brandColors={brandColors} onOpen={onOpen} />
          )}
        </div>

        <div className="right-col">
          <Breakdown byCounts={byCounts} total={graphData.nodes.length} />
          <TopHubs nodes={graphData.nodes} links={graphData.links} onOpen={onOpen} />
        </div>
      </div>

      <DetailPanel page={detailPage} onOpen={onOpen} />
    </div>
  );
}
