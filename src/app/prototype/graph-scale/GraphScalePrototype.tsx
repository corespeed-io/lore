"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { typeColor } from "@/lib/colors";
import type { GraphData, GraphNode } from "@/lib/types";
import { mountGraph } from "@/lib/viz/graph";

export type PrototypeVariant = "canvas" | "worker" | "svg";

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

interface RenderMetrics {
  drawMs: number;
  frames: number;
}

const LAYOUT_WIDTH = 1_600;
const LAYOUT_HEIGHT = 1_000;
const VARIANTS: { id: PrototypeVariant; label: string; description: string }[] = [
  {
    id: "canvas",
    label: "Canvas static",
    description: "One canvas, deterministic positions, no force calculation.",
  },
  {
    id: "worker",
    label: "Canvas + Worker",
    description: "D3 force runs off the main thread, then Canvas owns interaction.",
  },
  {
    id: "svg",
    label: "Current SVG",
    description: "The existing production renderer, mounted unchanged as the control.",
  },
];

function staticPositions(nodes: GraphNode[]): PositionedNode[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  return nodes.map((node, index) => {
    const radius = 8.2 * Math.sqrt(index);
    const angle = index * goldenAngle;
    return {
      ...node,
      x: LAYOUT_WIDTH / 2 + Math.cos(angle) * radius,
      y: LAYOUT_HEIGHT / 2 + Math.sin(angle) * radius,
    };
  });
}

function CanvasRenderer({
  data,
  nodes,
  onMetrics,
}: {
  data: GraphData;
  nodes: PositionedNode[];
  onMetrics: (metrics: RenderMetrics) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const mutableNodes = nodes.map((node) => ({ ...node }));
    const nodeById = new Map(mutableNodes.map((node) => [node.id, node]));
    const groups = new Map<string, PositionedNode[]>();
    for (const node of mutableNodes) {
      const group = groups.get(node.type) ?? [];
      group.push(node);
      groups.set(node.type, group);
    }

    let width = 1;
    let height = 1;
    let dpr = 1;
    let frame = 0;
    let frameCount = 0;
    let lastMetricAt = 0;
    let transform = { x: 0, y: 0, k: 1 };
    let dragged: PositionedNode | null = null;
    let panFrom: { x: number; y: number; tx: number; ty: number } | null = null;

    const draw = () => {
      frame = 0;
      const startedAt = performance.now();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(transform.x, transform.y);
      context.scale(transform.k, transform.k);

      context.beginPath();
      for (const link of data.links) {
        const source = nodeById.get(link.source);
        const target = nodeById.get(link.target);
        if (!source || !target) continue;
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
      }
      context.strokeStyle = "rgba(23, 23, 23, 0.085)";
      context.lineWidth = 0.72 / transform.k;
      context.stroke();

      for (const [type, typedNodes] of groups) {
        context.beginPath();
        for (const node of typedNodes) {
          context.moveTo(node.x + 2.3, node.y);
          context.arc(node.x, node.y, 2.3, 0, Math.PI * 2);
        }
        context.fillStyle = typeColor(type);
        context.fill();
      }

      if (dragged) {
        context.beginPath();
        context.arc(dragged.x, dragged.y, 5.5 / transform.k, 0, Math.PI * 2);
        context.strokeStyle = "#171717";
        context.lineWidth = 1.5 / transform.k;
        context.stroke();
      }
      context.restore();

      frameCount += 1;
      const now = performance.now();
      if (now - lastMetricAt > 250 || frameCount === 1) {
        lastMetricAt = now;
        onMetrics({ drawMs: now - startedAt, frames: frameCount });
      }
    };

    const scheduleDraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const fitCanvas = () => {
      const padding = 42;
      const scale = Math.min(
        (width - padding * 2) / LAYOUT_WIDTH,
        (height - padding * 2) / LAYOUT_HEIGHT,
      );
      transform = {
        x: (width - LAYOUT_WIDTH * scale) / 2,
        y: (height - LAYOUT_HEIGHT * scale) / 2,
        k: scale,
      };
      scheduleDraw();
    };

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      width = Math.max(1, box.width);
      height = Math.max(1, box.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      fitCanvas();
    };

    const worldPoint = (event: PointerEvent | WheelEvent) => {
      const box = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - box.left - transform.x) / transform.k,
        y: (event.clientY - box.top - transform.y) / transform.k,
      };
    };

    const pointerDown = (event: PointerEvent) => {
      const world = worldPoint(event);
      const hitRadius = 10 / transform.k;
      let nearestDistance = hitRadius * hitRadius;
      for (const node of mutableNodes) {
        const dx = node.x - world.x;
        const dy = node.y - world.y;
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          dragged = node;
        }
      }
      if (!dragged) {
        panFrom = {
          x: event.clientX,
          y: event.clientY,
          tx: transform.x,
          ty: transform.y,
        };
      }
      canvas.setPointerCapture(event.pointerId);
      scheduleDraw();
    };

    const pointerMove = (event: PointerEvent) => {
      if (dragged) {
        const world = worldPoint(event);
        dragged.x = world.x;
        dragged.y = world.y;
      } else if (panFrom) {
        transform.x = panFrom.tx + event.clientX - panFrom.x;
        transform.y = panFrom.ty + event.clientY - panFrom.y;
      } else {
        return;
      }
      scheduleDraw();
    };

    const pointerUp = (event: PointerEvent) => {
      dragged = null;
      panFrom = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      scheduleDraw();
    };

    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      const cursorX = event.clientX - box.left;
      const cursorY = event.clientY - box.top;
      const nextScale = Math.max(0.08, Math.min(8, transform.k * Math.exp(-event.deltaY * 0.0015)));
      const ratio = nextScale / transform.k;
      transform.x = cursorX - (cursorX - transform.x) * ratio;
      transform.y = cursorY - (cursorY - transform.y) * ratio;
      transform.k = nextScale;
      scheduleDraw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("wheel", wheel, { passive: false });
    resize();

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [data.links, nodes, onMetrics]);

  return <canvas ref={canvasRef} className="graph-scale-canvas" aria-label="Graph benchmark" />;
}

function StaticCanvasVariant({ data }: { data: GraphData }) {
  const nodes = useMemo(() => staticPositions(data.nodes), [data.nodes]);
  const [metrics, setMetrics] = useState<RenderMetrics>({ drawMs: 0, frames: 0 });
  const updateMetrics = useCallback((next: RenderMetrics) => setMetrics(next), []);
  return (
    <div className="graph-scale-stage">
      <CanvasRenderer data={data} nodes={nodes} onMetrics={updateMetrics} />
      <div className="graph-scale-render-state">
        <span>static layout</span>
        <span>{metrics.drawMs.toFixed(1)}ms draw</span>
        <span>{metrics.frames} frames</span>
      </div>
    </div>
  );
}

function WorkerCanvasVariant({ data }: { data: GraphData }) {
  const fallback = useMemo(() => staticPositions(data.nodes), [data.nodes]);
  const [nodes, setNodes] = useState(fallback);
  const [progress, setProgress] = useState(0);
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<RenderMetrics>({ drawMs: 0, frames: 0 });
  const updateMetrics = useCallback((next: RenderMetrics) => setMetrics(next), []);

  useEffect(() => {
    const worker = new Worker(new URL("./graph-scale.worker.ts", import.meta.url));
    worker.onmessage = (
      event: MessageEvent<
        | { type: "progress"; progress: number }
        | { type: "done"; positions: Float32Array; layoutMs: number }
      >,
    ) => {
      if (event.data.type === "progress") {
        setProgress(event.data.progress);
        return;
      }
      const result = event.data;
      const positioned = data.nodes.map((node, index) => ({
        ...node,
        x: result.positions[index * 2] ?? 0,
        y: result.positions[index * 2 + 1] ?? 0,
      }));
      setNodes(positioned);
      setProgress(1);
      setLayoutMs(result.layoutMs);
    };
    worker.postMessage({
      nodes: data.nodes.map((node) => ({ id: node.id })),
      links: data.links.map((link) => ({ source: link.source, target: link.target })),
      width: LAYOUT_WIDTH,
      height: LAYOUT_HEIGHT,
    });
    return () => worker.terminate();
  }, [data]);

  return (
    <div className="graph-scale-stage">
      <CanvasRenderer data={data} nodes={nodes} onMetrics={updateMetrics} />
      <div className="graph-scale-render-state">
        <span>
          {layoutMs === null ? `worker ${(progress * 100).toFixed(0)}%` : "worker complete"}
        </span>
        <span>{layoutMs === null ? "main thread free" : `${layoutMs.toFixed(0)}ms layout`}</span>
        <span>{metrics.drawMs.toFixed(1)}ms draw</span>
      </div>
    </div>
  );
}

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
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState({ milliseconds: 0, bytes: 0 });

  useEffect(() => setVariant(initialVariant), [initialVariant]);

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = performance.now();
    fetch("/api/prototype/graph-scale", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.text();
        if (!response.ok) throw new Error(JSON.parse(body).error ?? `HTTP ${response.status}`);
        const graph = JSON.parse(body) as GraphData;
        setFetchState({ milliseconds: performance.now() - startedAt, bytes: body.length });
        setData(graph);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Benchmark load failed");
      });
    return () => controller.abort();
  }, []);

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
          <h1>5,000 Memories · 20,000 Links</h1>
        </div>
        <div className="graph-scale-metrics" aria-live="polite">
          <span>{data ? data.nodes.length.toLocaleString() : "—"} nodes</span>
          <span>{data ? data.links.length.toLocaleString() : "—"} links</span>
          <span>
            {fetchState.milliseconds ? `${fetchState.milliseconds.toFixed(0)}ms fetch` : "loading"}
          </span>
          <span>{fetchState.bytes ? `${(fetchState.bytes / 1_048_576).toFixed(1)} MB` : "—"}</span>
        </div>
      </header>

      {error ? (
        <div className="graph-scale-message">Could not load benchmark: {error}</div>
      ) : !data ? (
        <div className="graph-scale-message">Reading benchmark PostgreSQL data…</div>
      ) : variant === "canvas" ? (
        <StaticCanvasVariant data={data} />
      ) : variant === "worker" ? (
        <WorkerCanvasVariant data={data} />
      ) : (
        <SvgVariant data={data} />
      )}

      {process.env.NODE_ENV !== "production" && (
        <PrototypeSwitcher variant={variant} onChange={changeVariant} />
      )}
    </main>
  );
}
