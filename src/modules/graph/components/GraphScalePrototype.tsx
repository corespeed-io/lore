"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGraphScalePrototype } from "@/modules/graph/prototype-hooks";
import { mountGraph } from "@/modules/graph/rendering/graph";
import type { GraphData } from "@/modules/graph/types";
import { StaticCanvasVariant, WorkerCanvasGraph } from "./WorkerCanvasGraph";

export type PrototypeVariant = "canvas" | "worker" | "svg";

const VARIANTS: { id: PrototypeVariant; label: string; description: string }[] = [
  {
    id: "canvas",
    label: "Canvas static",
    description: "One canvas, deterministic positions, no force calculation.",
  },
  {
    id: "worker",
    label: "Canvas + Worker",
    description: "D3 runs in Worker; every scale uses a compact field with adaptive interaction.",
  },
  {
    id: "svg",
    label: "Current SVG",
    description: "The existing production renderer, mounted unchanged as the control.",
  },
];

function SvgVariant({ data }: { data: GraphData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mountMs, setMountMs] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const startedAt = performance.now();
    const graph = mountGraph(element, data, { onSelect: () => undefined });
    setMountMs(performance.now() - startedAt);
    return () => graph.destroy();
  }, [data]);

  return (
    <div className="graph-scale-stage">
      <div ref={containerRef} className="graph-scale-svg" />
      <div className="graph-scale-render-state graph-scale-render-state-warn">
        <span>current SVG control</span>
        <span>{mountMs === null ? "mounting…" : `${mountMs.toFixed(0)}ms mount`}</span>
        <span>30,000 SVG elements</span>
      </div>
    </div>
  );
}

function PrototypeSwitcher({
  variant,
  onChange,
}: {
  variant: PrototypeVariant;
  onChange: (variant: PrototypeVariant) => void;
}) {
  const index = VARIANTS.findIndex((item) => item.id === variant);
  const cycle = useCallback(
    (direction: -1 | 1) => {
      const next = VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length];
      if (next) onChange(next.id);
    },
    [index, onChange],
  );

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable]")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [cycle]);

  return (
    <fieldset className="graph-scale-switcher" aria-label="Prototype renderer variants">
      <button type="button" onClick={() => cycle(-1)} aria-label="Previous renderer">
        ←
      </button>
      <div>
        <strong>{VARIANTS[index]?.label}</strong>
        <span>{VARIANTS[index]?.description}</span>
      </div>
      <button type="button" onClick={() => cycle(1)} aria-label="Next renderer">
        →
      </button>
    </fieldset>
  );
}

export function GraphScalePrototype({ initialVariant }: { initialVariant: PrototypeVariant }) {
  const router = useRouter();
  const [variant, setVariant] = useState(initialVariant);
  const { data: result, error: loadError } = useGraphScalePrototype();
  const data = result?.data;
  const error =
    loadError instanceof Error ? loadError.message : loadError ? "Benchmark load failed" : null;

  useEffect(() => setVariant(initialVariant), [initialVariant]);

  const changeVariant = useCallback(
    (next: PrototypeVariant) => {
      setVariant(next);
      router.replace(`/prototype/graph-scale?variant=${next}`, { scroll: false });
    },
    [router],
  );

  return (
    <main className="graph-scale-prototype">
      <header className="graph-scale-header">
        <div>
          <div className="graph-scale-kicker">Throwaway renderer prototype</div>
          <h1>
            {data
              ? `${data.nodes.length.toLocaleString()} Memories · ${data.links.length.toLocaleString()} Links`
              : "Graph scale benchmark"}
          </h1>
        </div>
        <div className="graph-scale-metrics" aria-live="polite">
          <span>{data ? data.nodes.length.toLocaleString() : "—"} nodes</span>
          <span>{data ? data.links.length.toLocaleString() : "—"} links</span>
          <span>{result ? `${result.milliseconds.toFixed(0)}ms fetch` : "loading"}</span>
          <span>{result ? `${(result.bytes / 1_048_576).toFixed(1)} MB` : "—"}</span>
        </div>
      </header>

      {error ? (
        <div className="graph-scale-message">Could not load benchmark: {error}</div>
      ) : !data ? (
        <div className="graph-scale-message">Reading benchmark PostgreSQL data…</div>
      ) : variant === "canvas" ? (
        <StaticCanvasVariant data={data} />
      ) : variant === "worker" ? (
        <WorkerCanvasGraph data={data} />
      ) : (
        <SvgVariant data={data} />
      )}

      {process.env.NODE_ENV !== "production" && (
        <PrototypeSwitcher variant={variant} onChange={changeVariant} />
      )}
    </main>
  );
}
