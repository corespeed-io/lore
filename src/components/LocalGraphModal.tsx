"use client";

import { useEffect, useMemo } from "react";
import { GraphView } from "@/components/GraphView";
import type { GraphData } from "@/lib/types";

interface LocalGraphModalProps {
  workspaceId: string;
  data: GraphData;
  focusId: string;
  title: string;
  onClose: () => void;
  onOpen: (memoryId: string) => void;
  onOpenGraph: (memoryId: string) => void;
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" strokeLinecap="round" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="3.5" cy="4" r="1.8" />
      <circle cx="12" cy="3.5" r="1.8" />
      <circle cx="8" cy="12" r="1.8" />
      <path d="M5.1 4.8 6.9 10.4M10.4 4.6 8.8 10.4M5.2 3.9 10.3 3.6" strokeLinecap="round" />
    </svg>
  );
}

function localGraphData(data: GraphData, focusId: string): GraphData {
  const ids = new Set<string>();
  if (data.nodes.some((node) => node.id === focusId)) ids.add(focusId);

  for (const link of data.links) {
    if (link.source === focusId) ids.add(link.target);
    if (link.target === focusId) ids.add(link.source);
  }

  return {
    nodes: data.nodes.filter((node) => ids.has(node.id)),
    links: data.links.filter((link) => ids.has(link.source) && ids.has(link.target)),
  };
}

export function LocalGraphModal({
  workspaceId,
  data,
  focusId,
  title,
  onClose,
  onOpen,
  onOpenGraph,
}: LocalGraphModalProps) {
  const localData = useMemo(() => localGraphData(data, focusId), [data, focusId]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="graph-modal-backdrop">
      <button
        type="button"
        className="graph-modal-scrim"
        aria-label="Close local graph"
        onClick={onClose}
      />
      <dialog open className="graph-modal" aria-modal="true" aria-labelledby="local-graph-title">
        <header className="graph-modal-header">
          <div className="graph-modal-title-wrap">
            <div className="graph-modal-kicker">Local graph</div>
            <h2 id="local-graph-title" className="graph-modal-title">
              {title}
            </h2>
          </div>
          <div className="graph-modal-actions">
            <button type="button" className="graph-modal-open" onClick={() => onOpenGraph(focusId)}>
              <GraphIcon />
              Open in Graph
            </button>
            <button
              type="button"
              className="graph-modal-close"
              aria-label="Close local graph"
              title="Close local graph"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </header>
        <div className="graph-modal-body">
          <GraphView
            workspaceId={workspaceId}
            data={localData}
            focusId={focusId}
            onOpen={(memoryId) => {
              onClose();
              onOpen(memoryId);
            }}
            className="graph-modal-graph"
          />
        </div>
      </dialog>
    </div>
  );
}
