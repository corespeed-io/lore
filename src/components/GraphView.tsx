"use client";

import type { GraphData } from "@/lib/types";
import { mountGraph } from "@/lib/viz/graph";
import { useEffect, useRef } from "react";

const BRAND_COLORS = {
  person: "#7F77DD",
  company: "#D85A30",
  product: "#1D9E75",
  concept: "#888780",
};

interface GraphViewProps {
  data: GraphData;
  onOpen: (slug: string) => void;
}

export function GraphView({ data, onOpen }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data.nodes.length) return;
    const instance = mountGraph(el, data, { colors: BRAND_COLORS, onOpen });
    return () => instance.destroy();
  }, [data, onOpen]);

  return (
    <div id="view" className="graph" ref={containerRef} style={{ height: "calc(100vh - 57px)" }}>
      <div className="glegend">
        <span>
          <span className="dot" style={{ background: "#7F77DD" }} />
          person
        </span>
        <span>
          <span className="dot" style={{ background: "#D85A30" }} />
          company
        </span>
        <span>
          <span className="dot" style={{ background: "#1D9E75" }} />
          product
        </span>
        <span>
          <span className="dot" style={{ background: "#888780" }} />
          concept
        </span>
      </div>
      <div className="ghint">
        {data.nodes.length} nodes · {data.links.length} links · drag · hover · click
      </div>
    </div>
  );
}
