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
    <div ref={containerRef} className="graph-fullscreen">
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
      <div className="ghint">
        {data.nodes.length} nodes · {data.links.length} links · drag · hover · click
      </div>
    </div>
  );
}
