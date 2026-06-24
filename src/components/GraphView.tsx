"use client";

import type { GraphData } from "@/lib/types";
import { mountGraph } from "@/lib/viz/graph";
import { useEffect, useRef } from "react";

interface GraphViewProps {
  data: GraphData;
  onOpen: (slug: string) => void;
  brandColors: Record<string, string>;
}

export function GraphView({ data, onOpen, brandColors }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data.nodes.length) return;
    const instance = mountGraph(el, data, { colors: brandColors, onOpen });
    return () => instance.destroy();
  }, [data, onOpen, brandColors]);

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
