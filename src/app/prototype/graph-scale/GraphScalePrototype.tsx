"use client";

import * as d3 from "d3";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { typeColor } from "@/lib/colors";
import type { GraphData, GraphNode } from "@/lib/types";
import { mountGraph } from "@/lib/viz/graph";

export type PrototypeVariant = "canvas" | "worker" | "svg";

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  radius: number;
}

interface RenderMetrics {
  drawMs: number;
  frames: number;
}

type NodeDragEvent = { phase: "start" | "move" | "end"; id: string; x: number; y: number };

type PositionSink = (positions: Float32Array, lockedId: string | null) => void;

interface CanvasDragSubject {
  node: PositionedNode;
  x: number;
  y: number;
}

const LAYOUT_WIDTH = 1_600;
const LAYOUT_HEIGHT = 1_000;
const COLLISION_GAP = 13;
const MIN_COLLISION_RADIUS = 4 + COLLISION_GAP;
const MAX_COLLISION_RADIUS = 16 + COLLISION_GAP;
const VARIANTS: { id: PrototypeVariant; label: string; description: string }[] = [
  {
    id: "canvas",
    label: "Canvas static",
    description: "One canvas, deterministic positions, no force calculation.",
  },
  {
    id: "worker",
    label: "Canvas + Worker",
    description: "The full D3 force graph runs in Worker; only nearby particles are released.",
  },
  {
    id: "svg",
    label: "Current SVG",
    description: "The existing production renderer, mounted unchanged as the control.",
  },
];

function nodeDegrees(data: GraphData) {
  const degrees = new Map<string, number>();
  for (const link of data.links) {
    degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
    degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
  }
  return degrees;
}

function staticPositions(data: GraphData): PositionedNode[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const degrees = nodeDegrees(data);
  return data.nodes.map((node, index) => {
    const radius = 8.2 * Math.sqrt(index);
    const angle = index * goldenAngle;
    return {
      ...node,
      x: LAYOUT_WIDTH / 2 + Math.cos(angle) * radius,
      y: LAYOUT_HEIGHT / 2 + Math.sin(angle) * radius,
      radius: 4 + Math.min(12, (degrees.get(node.id) ?? 0) * 1.1),
    };
  });
}

function CanvasRenderer({
  data,
  nodes,
  onMetrics,
  onNodeDrag,
  registerPositionSink,
}: {
  data: GraphData;
  nodes: PositionedNode[];
  onMetrics: (metrics: RenderMetrics) => void;
  onNodeDrag?: (event: NodeDragEvent) => void;
  registerPositionSink?: (sink: PositionSink | null) => void;
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
    let transform = d3.zoomIdentity;
    let dragged: PositionedNode | null = null;

    const layoutBounds = mutableNodes.reduce(
      (bounds, node) => ({
        minX: Math.min(bounds.minX, node.x - MAX_COLLISION_RADIUS),
        minY: Math.min(bounds.minY, node.y - MAX_COLLISION_RADIUS),
        maxX: Math.max(bounds.maxX, node.x + MAX_COLLISION_RADIUS),
        maxY: Math.max(bounds.maxY, node.y + MAX_COLLISION_RADIUS),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );

    const draw = () => {
      frame = 0;
      const drawStartedAt = performance.now();
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
          context.moveTo(node.x + node.radius, node.y);
          context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
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
        onMetrics({ drawMs: now - drawStartedAt, frames: frameCount });
      }
    };

    const scheduleDraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    registerPositionSink?.((positions, lockedId) => {
      for (let index = 0; index < mutableNodes.length; index += 1) {
        const node = mutableNodes[index];
        if (!node || node === dragged || node.id === lockedId) continue;
        node.x = positions[index * 2] ?? node.x;
        node.y = positions[index * 2 + 1] ?? node.y;
      }
      scheduleDraw();
    });

    const findNode = (x: number, y: number, radius: number) => {
      let nearest: PositionedNode | null = null;
      let nearestDistance = radius * radius;
      for (const node of mutableNodes) {
        const dx = node.x - x;
        const dy = node.y - y;
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = node;
        }
      }
      return nearest;
    };

    const selection = d3.select<HTMLCanvasElement, unknown>(canvas);
    let pendingSubject: CanvasDragSubject | null = null;
    const dragBehavior = d3
      .drag<HTMLCanvasElement, unknown, CanvasDragSubject>()
      .container(canvas)
      .filter((event) => {
        if (event.ctrlKey || event.button) return false;
        const [screenX, screenY] = d3.pointer(event, canvas);
        const [worldX, worldY] = transform.invert([screenX, screenY]);
        const node = findNode(worldX, worldY, 10 / transform.k);
        pendingSubject = node
          ? {
              node,
              x: transform.applyX(node.x),
              y: transform.applyY(node.y),
            }
          : null;
        return pendingSubject !== null;
      })
      .subject(() => pendingSubject as CanvasDragSubject)
      .on("start", (event) => {
        const node = event.subject.node;
        dragged = node;
        onNodeDrag?.({ phase: "start", id: node.id, x: node.x, y: node.y });
        scheduleDraw();
      })
      .on("drag", (event) => {
        const [x, y] = transform.invert([event.x, event.y]);
        event.subject.node.x = x;
        event.subject.node.y = y;
        onNodeDrag?.({ phase: "move", id: event.subject.node.id, x, y });
        scheduleDraw();
      })
      .on("end", (event) => {
        const node = event.subject.node;
        onNodeDrag?.({ phase: "end", id: node.id, x: node.x, y: node.y });
        dragged = null;
        scheduleDraw();
      });
    const zoomBehavior = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.08, 8])
      .on("zoom", (event) => {
        transform = event.transform;
        scheduleDraw();
      });

    const fitCanvas = () => {
      const padding = 42;
      const layoutWidth = Math.max(1, layoutBounds.maxX - layoutBounds.minX);
      const layoutHeight = Math.max(1, layoutBounds.maxY - layoutBounds.minY);
      const scale = Math.min(
        (width - padding * 2) / layoutWidth,
        (height - padding * 2) / layoutHeight,
      );
      const nextTransform = d3.zoomIdentity
        .translate(
          (width - layoutWidth * scale) / 2 - layoutBounds.minX * scale,
          (height - layoutHeight * scale) / 2 - layoutBounds.minY * scale,
        )
        .scale(scale);
      selection.call(zoomBehavior.transform, nextTransform);
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

    const observer = new ResizeObserver(resize);
    selection.call(dragBehavior).call(zoomBehavior);
    observer.observe(canvas);
    resize();

    return () => {
      observer.disconnect();
      registerPositionSink?.(null);
      if (frame) cancelAnimationFrame(frame);
      selection.on(".drag", null).on(".zoom", null);
    };
  }, [data.links, nodes, onMetrics, onNodeDrag, registerPositionSink]);

  return <canvas ref={canvasRef} className="graph-scale-canvas" aria-label="Graph benchmark" />;
}

function StaticCanvasVariant({ data }: { data: GraphData }) {
  const nodes = useMemo(() => staticPositions(data), [data]);
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
  const fallback = useMemo(() => staticPositions(data), [data]);
  const workerRef = useRef<Worker | null>(null);
  const positionSinkRef = useRef<PositionSink | null>(null);
  const [nodes, setNodes] = useState(fallback);
  const [progress, setProgress] = useState(0);
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  const [physicsState, setPhysicsState] = useState<"dragging" | "settling" | "settled">("settled");
  const [physicsFrames, setPhysicsFrames] = useState(0);
  const [activeParticles, setActiveParticles] = useState(0);
  const [activeLinks, setActiveLinks] = useState(0);
  const [metrics, setMetrics] = useState<RenderMetrics>({ drawMs: 0, frames: 0 });
  const updateMetrics = useCallback((next: RenderMetrics) => setMetrics(next), []);
  const registerPositionSink = useCallback((sink: PositionSink | null) => {
    positionSinkRef.current = sink;
  }, []);
  const dragNode = useCallback((event: NodeDragEvent) => {
    workerRef.current?.postMessage({ type: `drag-${event.phase}`, ...event });
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./graph-scale.worker.ts", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (
      event: MessageEvent<
        | { type: "progress"; progress: number }
        | { type: "ready"; positions: Float32Array; layoutMs: number }
        | {
            type: "frame";
            positions: Float32Array;
            frame: number;
            lockedId: string | null;
            activeNodes: number;
            activeLinks: number;
          }
        | { type: "status"; state: "dragging" | "settling" | "settled" }
      >,
    ) => {
      if (event.data.type === "progress") {
        setProgress(event.data.progress);
        return;
      }
      if (event.data.type === "frame") {
        positionSinkRef.current?.(event.data.positions, event.data.lockedId);
        if (event.data.frame % 6 === 0 || event.data.activeNodes === 0) {
          setPhysicsFrames(event.data.frame);
          setActiveParticles(event.data.activeNodes);
          setActiveLinks(event.data.activeLinks);
        }
        return;
      }
      if (event.data.type === "status") {
        if (event.data.state === "dragging") {
          setPhysicsFrames(0);
          setActiveParticles(0);
          setActiveLinks(0);
        }
        setPhysicsState(event.data.state);
        return;
      }
      const result = event.data;
      const positioned = data.nodes.map((node, index) => ({
        ...node,
        x: result.positions[index * 2] ?? 0,
        y: result.positions[index * 2 + 1] ?? 0,
        radius: fallback[index]?.radius ?? 4,
      }));
      setNodes(positioned);
      setProgress(1);
      setLayoutMs(result.layoutMs);
    };
    worker.postMessage({
      type: "init",
      nodes: data.nodes.map((node) => ({ id: node.id })),
      links: data.links.map((link) => ({ source: link.source, target: link.target })),
      width: LAYOUT_WIDTH,
      height: LAYOUT_HEIGHT,
      collisionGap: COLLISION_GAP,
    });
    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, [data, fallback]);

  return (
    <div className="graph-scale-stage">
      <CanvasRenderer
        data={data}
        nodes={nodes}
        onMetrics={updateMetrics}
        onNodeDrag={dragNode}
        registerPositionSink={registerPositionSink}
      />
      <div className="graph-scale-render-state">
        <span>
          {layoutMs === null
            ? `worker ${(progress * 100).toFixed(0)}%`
            : physicsState === "settled"
              ? "particles settled"
              : `particles ${physicsState}`}
        </span>
        <span>{layoutMs === null ? "main thread free" : `${layoutMs.toFixed(0)}ms layout`}</span>
        <span>
          {MIN_COLLISION_RADIUS}–{MAX_COLLISION_RADIUS}px collision
        </span>
        <span>{physicsFrames} physics frames</span>
        <span>{activeParticles} active particles</span>
        <span>{activeLinks} influencing links</span>
        <span>{metrics.drawMs.toFixed(1)}ms draw</span>
        <span>{metrics.frames} frames</span>
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
