"use client";

import * as d3 from "d3";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { typeColor } from "@/lib/colors";
import type { GraphData, GraphNode } from "@/lib/types";
import { type GraphInstance, graphLabelText, mountGraph } from "@/lib/viz/graph";
import { graphNodeCentrality } from "@/lib/viz/graph-centrality";

export type PrototypeVariant = "canvas" | "worker" | "svg";

interface PositionedNode extends GraphNode {
  degree: number;
  gravity: number;
  hub: boolean;
  x: number;
  y: number;
  radius: number;
}

interface RenderMetrics {
  drawMs: number;
  frames: number;
  renderedNodes: number;
  renderedLinks: number;
}

type NodeDragEvent = { phase: "start" | "move" | "end"; id: string; x: number; y: number };

interface PositionDelta {
  nodeIndices: Uint32Array;
  positions: Float32Array;
  lockedId: string | null;
}

type PositionSink = (delta: PositionDelta) => void;
type LayoutPreviewSink = (delta: Omit<PositionDelta, "lockedId">) => void;
type LayoutCompleteSink = () => void;
type GraphInstanceSink = (instance: GraphInstance | null) => void;

interface CanvasDragSubject {
  node: PositionedNode;
  x: number;
  y: number;
}

const LAYOUT_WIDTH = 1_600;
const LAYOUT_HEIGHT = 1_000;
const COLLISION_GAP = 13;
const PRODUCTION_COLLISION_GAP = 12;
const MIN_COLLISION_RADIUS = 4 + COLLISION_GAP;
const MAX_COLLISION_RADIUS = 16 + COLLISION_GAP;
const MAX_RENDERED_LINKS = 40_000;
const LAYOUT_REVEAL_TRANSITION_MS = 220;
const INITIAL_REVEAL_FIT_RATIO = 0.02;
const INITIAL_REVEAL_FIT_MIN_NODES = 64;
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

function staticPositions(data: GraphData): PositionedNode[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const centrality = graphNodeCentrality(data.nodes, data.links);
  return data.nodes.map((node, index) => {
    const metric = centrality.get(node.id) ?? { degree: 0, gravity: 0, hub: false, radius: 4 };
    const placementRadius = 8.2 * Math.sqrt(index);
    const angle = index * goldenAngle;
    return {
      ...node,
      ...metric,
      x: LAYOUT_WIDTH / 2 + Math.cos(angle) * placementRadius,
      y: LAYOUT_HEIGHT / 2 + Math.sin(angle) * placementRadius,
    };
  });
}

function CanvasRenderer({
  data,
  nodes,
  onMetrics,
  onNodeDrag,
  onSelect,
  registerGraphInstance,
  registerPositionSink,
  layoutPending = false,
  registerLayoutPreviewSink,
  registerLayoutCompleteSink,
  production = false,
}: {
  data: GraphData;
  nodes: PositionedNode[];
  onMetrics: (metrics: RenderMetrics) => void;
  onNodeDrag?: (event: NodeDragEvent) => void;
  onSelect?: (memoryId: string | null) => void;
  registerGraphInstance?: GraphInstanceSink;
  registerPositionSink?: (sink: PositionSink | null) => void;
  layoutPending?: boolean;
  registerLayoutPreviewSink?: (sink: LayoutPreviewSink | null) => void;
  registerLayoutCompleteSink?: (sink: LayoutCompleteSink | null) => void;
  production?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const mutableNodes = nodes.map((node) => ({ ...node }));
    const nodeById = new Map(mutableNodes.map((node) => [node.id, node]));
    const nodeIndexById = new Map(mutableNodes.map((node, index) => [node.id, index]));
    const adjacentIds = new Map(mutableNodes.map((node) => [node.id, new Set([node.id])]));
    for (const link of data.links) {
      adjacentIds.get(link.source)?.add(link.target);
      adjacentIds.get(link.target)?.add(link.source);
    }
    const labelOrder = [...mutableNodes].sort(
      (left, right) => right.radius - left.radius || left.label.localeCompare(right.label),
    );
    const visibleNodeMask = layoutPending ? new Uint8Array(mutableNodes.length) : null;
    const revealStartedAt = layoutPending ? new Float64Array(mutableNodes.length).fill(-1) : null;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const linkStep = Math.max(1, Math.ceil(data.links.length / MAX_RENDERED_LINKS));
    const renderLinks = data.links.filter((_, index) => index % linkStep === 0);
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
    let fitFrame = 0;
    let frameCount = 0;
    let lastMetricAt = 0;
    let transform = d3.zoomIdentity;
    let dragged: PositionedNode | null = null;
    let revealedNodeCount = 0;
    let previewFitStarted = false;
    let activeIds: Set<string> | null = null;
    let selectedId: string | null = null;
    let hoveredId: string | null = null;

    const currentLayoutBounds = (visibleOnly = false) =>
      mutableNodes.reduce(
        (bounds, node, index) =>
          visibleOnly && visibleNodeMask && !visibleNodeMask[index]
            ? bounds
            : {
                minX: Math.min(bounds.minX, node.x - MAX_COLLISION_RADIUS),
                minY: Math.min(bounds.minY, node.y - MAX_COLLISION_RADIUS),
                maxX: Math.max(bounds.maxX, node.x + MAX_COLLISION_RADIUS),
                maxY: Math.max(bounds.maxY, node.y + MAX_COLLISION_RADIUS),
              },
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

      const [minimumX, minimumY] = transform.invert([-MAX_COLLISION_RADIUS, -MAX_COLLISION_RADIUS]);
      const [maximumX, maximumY] = transform.invert([
        width + MAX_COLLISION_RADIUS,
        height + MAX_COLLISION_RADIUS,
      ]);
      const focusId = selectedId ?? hoveredId;
      const focusedIds = focusId ? adjacentIds.get(focusId) : null;
      const revealNow = performance.now();
      let revealAnimationActive = false;

      const nodeIsVisible = (node: PositionedNode) => {
        const nodeIndex = nodeIndexById.get(node.id) ?? -1;
        if (visibleNodeMask && !visibleNodeMask[nodeIndex]) return false;
        return !(
          node.x + node.radius < minimumX ||
          node.x - node.radius > maximumX ||
          node.y + node.radius < minimumY ||
          node.y - node.radius > maximumY
        );
      };
      const visibleRadius = (node: PositionedNode) => {
        const nodeIndex = nodeIndexById.get(node.id) ?? -1;
        const revealProgress = revealStartedAt
          ? Math.min(
              1,
              Math.max(
                0,
                (revealNow - (revealStartedAt[nodeIndex] ?? 0)) / LAYOUT_REVEAL_TRANSITION_MS,
              ),
            )
          : 1;
        if (revealProgress < 1) revealAnimationActive = true;
        return node.radius * (1 - (1 - revealProgress) ** 3);
      };

      const drawLinks = (focusedOnly: boolean) => {
        context.beginPath();
        let count = 0;
        for (const link of renderLinks) {
          const source = nodeById.get(link.source);
          const target = nodeById.get(link.target);
          if (!source || !target) continue;
          if (
            visibleNodeMask &&
            (!visibleNodeMask[nodeIndexById.get(source.id) ?? -1] ||
              !visibleNodeMask[nodeIndexById.get(target.id) ?? -1])
          ) {
            continue;
          }
          if (focusedOnly && link.source !== focusId && link.target !== focusId) continue;
          if (
            Math.max(source.x, target.x) < minimumX ||
            Math.min(source.x, target.x) > maximumX ||
            Math.max(source.y, target.y) < minimumY ||
            Math.min(source.y, target.y) > maximumY
          ) {
            continue;
          }
          context.moveTo(source.x, source.y);
          context.lineTo(target.x, target.y);
          count += 1;
        }
        context.strokeStyle = focusedOnly
          ? "rgba(23, 23, 23, 0.44)"
          : focusedIds
            ? "rgba(23, 23, 23, 0.025)"
            : "rgba(23, 23, 23, 0.085)";
        context.lineWidth = (focusedOnly ? 1.15 : 0.72) / transform.k;
        context.stroke();
        return count;
      };

      const renderedLinks = drawLinks(false);
      if (focusedIds) drawLinks(true);

      let renderedNodes = 0;
      const drawNodeGroups = (focusedOnly: boolean) => {
        for (const [type, typedNodes] of groups) {
          context.beginPath();
          for (const node of typedNodes) {
            if (!nodeIsVisible(node)) continue;
            if (focusedOnly && !focusedIds?.has(node.id)) continue;
            const radius = visibleRadius(node);
            if (radius <= 0) continue;
            context.moveTo(node.x + radius, node.y);
            context.arc(node.x, node.y, radius, 0, Math.PI * 2);
            if (!focusedOnly) renderedNodes += 1;
          }
          context.fillStyle = typeColor(type);
          context.globalAlpha = focusedOnly ? 1 : focusedIds ? 0.14 : 1;
          context.fill();
        }
        context.globalAlpha = 1;
      };
      drawNodeGroups(false);
      if (focusedIds) drawNodeGroups(true);

      for (const node of mutableNodes) {
        if (!nodeIsVisible(node)) continue;
        const isMatch = activeIds?.has(node.id) ?? false;
        const isSelected = node.id === selectedId;
        const isHovered = node.id === hoveredId;
        if (!isMatch && !isSelected && !isHovered) continue;
        const radius = visibleRadius(node);
        if (radius <= 0) continue;
        context.beginPath();
        context.arc(node.x, node.y, radius + (isSelected ? 4 : 2.5) / transform.k, 0, Math.PI * 2);
        context.strokeStyle = isSelected ? "#171717" : typeColor(node.type);
        context.lineWidth = (isSelected ? 2 : 1.5) / transform.k;
        context.stroke();
      }

      if (production) {
        const occupied: { x0: number; x1: number; y0: number; y1: number }[] = [];
        context.textBaseline = "middle";
        for (const node of labelOrder) {
          if (!nodeIsVisible(node)) continue;
          const directLabel = node.id === selectedId || node.id === hoveredId;
          if (!directLabel && !activeIds?.has(node.id)) continue;
          const label = graphLabelText(node.label);
          const labelHeight = 14;
          const labelGap = 6;
          context.font = "500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
          const textWidth = context.measureText(label).width;
          const radius = Math.max(1, visibleRadius(node));
          const side = node.x > transform.invertX(width / 2) ? -1 : 1;
          const placements = [
            {
              x: node.x + side * (radius + labelGap),
              y: node.y,
              align: side > 0 ? ("left" as const) : ("right" as const),
            },
            { x: node.x, y: node.y - radius - labelGap, align: "center" as const },
            { x: node.x, y: node.y + radius + labelGap, align: "center" as const },
          ];
          let placement: (typeof placements)[number] | null = null;
          let bounds: { x0: number; x1: number; y0: number; y1: number } | null = null;
          for (const candidate of placements) {
            const x0 =
              candidate.align === "left"
                ? candidate.x
                : candidate.align === "right"
                  ? candidate.x - textWidth
                  : candidate.x - textWidth / 2;
            const candidateBounds = {
              x0: x0 - 2,
              x1: x0 + textWidth + 2,
              y0: candidate.y - labelHeight / 2,
              y1: candidate.y + labelHeight / 2,
            };
            if (
              directLabel ||
              !occupied.some(
                (box) =>
                  candidateBounds.x0 < box.x1 &&
                  candidateBounds.x1 > box.x0 &&
                  candidateBounds.y0 < box.y1 &&
                  candidateBounds.y1 > box.y0,
              )
            ) {
              placement = candidate;
              bounds = candidateBounds;
              break;
            }
          }
          if (!placement || !bounds) continue;
          occupied.push(bounds);
          context.textAlign = placement.align;
          context.fillStyle = "#525252";
          context.globalAlpha = focusedIds && !focusedIds.has(node.id) ? 0.18 : 0.86;
          context.fillText(label, placement.x, placement.y);
          context.globalAlpha = 1;
        }
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
        onMetrics({
          drawMs: now - drawStartedAt,
          frames: frameCount,
          renderedNodes,
          renderedLinks,
        });
      }
      if (revealAnimationActive) frame = requestAnimationFrame(draw);
    };

    const scheduleDraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    registerPositionSink?.(({ nodeIndices, positions, lockedId }) => {
      for (let deltaIndex = 0; deltaIndex < nodeIndices.length; deltaIndex += 1) {
        const node = mutableNodes[nodeIndices[deltaIndex] ?? -1];
        if (!node || node.id === lockedId) continue;
        node.x = positions[deltaIndex * 2] ?? node.x;
        node.y = positions[deltaIndex * 2 + 1] ?? node.y;
      }
      scheduleDraw();
    });

    registerLayoutPreviewSink?.(({ nodeIndices, positions }) => {
      if (!visibleNodeMask) return;
      for (let deltaIndex = 0; deltaIndex < nodeIndices.length; deltaIndex += 1) {
        const nodeIndex = nodeIndices[deltaIndex] ?? -1;
        const node = mutableNodes[nodeIndex];
        if (!node) continue;
        node.x = positions[deltaIndex * 2] ?? node.x;
        node.y = positions[deltaIndex * 2 + 1] ?? node.y;
        if (!visibleNodeMask[nodeIndex] && revealStartedAt) {
          revealStartedAt[nodeIndex] = reduceMotion ? 0 : performance.now();
          revealedNodeCount += 1;
        }
        visibleNodeMask[nodeIndex] = 1;
      }
      const previewFitThreshold = Math.min(
        mutableNodes.length,
        Math.max(
          INITIAL_REVEAL_FIT_MIN_NODES,
          Math.ceil(mutableNodes.length * INITIAL_REVEAL_FIT_RATIO),
        ),
      );
      if (!previewFitStarted && revealedNodeCount >= previewFitThreshold) {
        previewFitStarted = true;
        fitCanvas(true, true);
      }
      scheduleDraw();
    });

    const findNode = (x: number, y: number, radius: number) => {
      let nearest: PositionedNode | null = null;
      let nearestDistance = radius * radius;
      for (const node of mutableNodes) {
        if (visibleNodeMask && !visibleNodeMask[nodeIndexById.get(node.id) ?? -1]) continue;
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
        if (production) hoveredId = node.id;
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
        const [x, y] = transform.invert([event.x, event.y]);
        onNodeDrag?.({ phase: "end", id: node.id, x, y });
        dragged = null;
        if (production) {
          hoveredId = null;
          canvas.classList.remove("graph-canvas-node-hover");
        }
        scheduleDraw();
      });
    const zoomBehavior = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.0001, 8])
      .on("zoom", (event) => {
        transform = event.transform;
        scheduleDraw();
      });

    const fitCanvas = (animate = false, visibleOnly = false) => {
      const padding = 42;
      const layoutBounds = currentLayoutBounds(visibleOnly);
      const layoutWidth = Math.max(1, layoutBounds.maxX - layoutBounds.minX);
      const layoutHeight = Math.max(1, layoutBounds.maxY - layoutBounds.minY);
      const scale = Math.min(
        (width - padding * 2) / layoutWidth,
        (height - padding * 2) / layoutHeight,
      );
      zoomBehavior.scaleExtent([layoutPending ? 0.0001 : Math.max(0.0001, Math.min(scale, 1)), 8]);
      const nextTransform = d3.zoomIdentity
        .translate(
          (width - layoutWidth * scale) / 2 - layoutBounds.minX * scale,
          (height - layoutHeight * scale) / 2 - layoutBounds.minY * scale,
        )
        .scale(scale);
      if (fitFrame) {
        cancelAnimationFrame(fitFrame);
        fitFrame = 0;
      }
      if (!animate || reduceMotion) {
        selection.call(zoomBehavior.transform, nextTransform);
        return;
      }
      const startedAt = performance.now();
      const startTransform = transform;
      const animateFit = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / 420);
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
        const interpolated = d3.zoomIdentity
          .translate(
            startTransform.x + (nextTransform.x - startTransform.x) * eased,
            startTransform.y + (nextTransform.y - startTransform.y) * eased,
          )
          .scale(startTransform.k + (nextTransform.k - startTransform.k) * eased);
        selection.call(zoomBehavior.transform, interpolated);
        if (progress < 1) fitFrame = requestAnimationFrame(animateFit);
        else fitFrame = 0;
      };
      fitFrame = requestAnimationFrame(animateFit);
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
    selection.on("dblclick.zoom", null);
    if (production) {
      selection
        .on("pointermove.graph-focus", (event: PointerEvent) => {
          if (dragged || event.buttons) return;
          const [screenX, screenY] = d3.pointer(event, canvas);
          const [worldX, worldY] = transform.invert([screenX, screenY]);
          const nextId = findNode(worldX, worldY, 12 / transform.k)?.id ?? null;
          if (nextId === hoveredId) return;
          hoveredId = nextId;
          canvas.classList.toggle("graph-canvas-node-hover", Boolean(nextId));
          scheduleDraw();
        })
        .on("pointerleave.graph-focus", () => {
          if (dragged || !hoveredId) return;
          hoveredId = null;
          canvas.classList.remove("graph-canvas-node-hover");
          scheduleDraw();
        })
        .on("click.graph-select", (event: MouseEvent) => {
          const [screenX, screenY] = d3.pointer(event, canvas);
          const [worldX, worldY] = transform.invert([screenX, screenY]);
          const nextId = findNode(worldX, worldY, 12 / transform.k)?.id ?? null;
          if (nextId) event.stopPropagation();
          onSelect?.(nextId);
        })
        .on("dblclick.graph-fit", (event: MouseEvent) => {
          const [screenX, screenY] = d3.pointer(event, canvas);
          const [worldX, worldY] = transform.invert([screenX, screenY]);
          if (findNode(worldX, worldY, 12 / transform.k)) return;
          event.preventDefault();
          fitCanvas(true);
        });
    }
    observer.observe(canvas);
    resize();
    registerLayoutCompleteSink?.(() => fitCanvas(true));
    registerGraphInstance?.({
      destroy() {},
      fit() {
        fitCanvas(true);
      },
      highlight(ids) {
        activeIds = ids;
        scheduleDraw();
      },
      resetZoom() {
        selection.call(zoomBehavior.transform, d3.zoomIdentity);
      },
      select(id) {
        selectedId = id;
        if (id) hoveredId = null;
        scheduleDraw();
      },
      zoomIn() {
        selection.call(zoomBehavior.scaleBy, 1.25);
      },
      zoomOut() {
        selection.call(zoomBehavior.scaleBy, 0.8);
      },
    });

    return () => {
      observer.disconnect();
      registerGraphInstance?.(null);
      registerPositionSink?.(null);
      registerLayoutPreviewSink?.(null);
      registerLayoutCompleteSink?.(null);
      if (frame) cancelAnimationFrame(frame);
      if (fitFrame) cancelAnimationFrame(fitFrame);
      selection
        .on(".drag", null)
        .on(".zoom", null)
        .on(".graph-focus", null)
        .on(".graph-select", null)
        .on(".graph-fit", null);
    };
  }, [
    data.links,
    layoutPending,
    nodes,
    onMetrics,
    onNodeDrag,
    onSelect,
    production,
    registerGraphInstance,
    registerLayoutPreviewSink,
    registerLayoutCompleteSink,
    registerPositionSink,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className={`graph-scale-canvas${production ? " graph-canvas" : ""}`}
      aria-label={production ? "Memory graph" : "Graph benchmark"}
    />
  );
}

function StaticCanvasVariant({ data }: { data: GraphData }) {
  const nodes = useMemo(() => staticPositions(data), [data]);
  const [metrics, setMetrics] = useState<RenderMetrics>({
    drawMs: 0,
    frames: 0,
    renderedNodes: 0,
    renderedLinks: 0,
  });
  const updateMetrics = useCallback((next: RenderMetrics) => setMetrics(next), []);
  return (
    <div className="graph-scale-stage">
      <CanvasRenderer data={data} nodes={nodes} onMetrics={updateMetrics} />
      <div className="graph-scale-render-state">
        <span>static layout</span>
        <span>{metrics.drawMs.toFixed(1)}ms draw</span>
        <span>{metrics.renderedNodes.toLocaleString()} visible nodes</span>
        <span>{metrics.renderedLinks.toLocaleString()} visible links</span>
        <span>{metrics.frames} frames</span>
      </div>
    </div>
  );
}

export function WorkerCanvasGraph({
  data,
  onSelect,
  registerGraphInstance,
  production = false,
  showMetrics = true,
}: {
  data: GraphData;
  onSelect?: (memoryId: string | null) => void;
  registerGraphInstance?: GraphInstanceSink;
  production?: boolean;
  showMetrics?: boolean;
}) {
  const fallback = useMemo(() => staticPositions(data), [data]);
  const workerGraph = useMemo(
    () => ({
      nodes: fallback.map((node) => ({
        id: node.id,
        gravity: node.gravity,
        hub: node.hub,
        radius: node.radius,
      })),
      links: data.links.map((link) => ({ source: link.source, target: link.target })),
      collisionGap: production ? PRODUCTION_COLLISION_GAP : COLLISION_GAP,
    }),
    [data.links, fallback, production],
  );
  const workerRef = useRef<Worker | null>(null);
  const positionSinkRef = useRef<PositionSink | null>(null);
  const layoutPreviewSinkRef = useRef<LayoutPreviewSink | null>(null);
  const layoutCompleteSinkRef = useRef<LayoutCompleteSink | null>(null);
  const [layoutProgress, setLayoutProgress] = useState({
    tick: 0,
    totalTicks: 0,
    revealedNodes: 0,
  });
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  const [layoutTicks, setLayoutTicks] = useState<number | null>(null);
  const [physicsState, setPhysicsState] = useState<"dragging" | "settling" | "settled">("settled");
  const [physicsFrames, setPhysicsFrames] = useState(0);
  const [activeParticles, setActiveParticles] = useState(0);
  const [activeLinks, setActiveLinks] = useState(0);
  const [transferredNodes, setTransferredNodes] = useState(0);
  const [simulatedNodes, setSimulatedNodes] = useState(0);
  const [simulatedLinks, setSimulatedLinks] = useState(0);
  const [physicsFps, setPhysicsFps] = useState(0);
  const [metrics, setMetrics] = useState<RenderMetrics>({
    drawMs: 0,
    frames: 0,
    renderedNodes: 0,
    renderedLinks: 0,
  });
  const updateMetrics = useCallback(
    (next: RenderMetrics) => {
      if (showMetrics) setMetrics(next);
    },
    [showMetrics],
  );
  const registerPositionSink = useCallback((sink: PositionSink | null) => {
    positionSinkRef.current = sink;
  }, []);
  const registerLayoutPreviewSink = useCallback((sink: LayoutPreviewSink | null) => {
    layoutPreviewSinkRef.current = sink;
  }, []);
  const registerLayoutCompleteSink = useCallback((sink: LayoutCompleteSink | null) => {
    layoutCompleteSinkRef.current = sink;
  }, []);
  const dragNode = useCallback((event: NodeDragEvent) => {
    workerRef.current?.postMessage({ type: `drag-${event.phase}`, ...event });
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./graph-scale.worker.ts", import.meta.url));
    let completionTimer: ReturnType<typeof setTimeout> | null = null;
    const revealTransitionMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : LAYOUT_REVEAL_TRANSITION_MS;
    workerRef.current = worker;
    worker.onmessage = (
      event: MessageEvent<
        | {
            type: "progress";
            tick: number;
            totalTicks: number;
            revealedNodes: number;
            nodeIndices: Uint32Array;
            positions: Float32Array;
          }
        | { type: "ready"; layoutMs: number; layoutTicks: number }
        | {
            type: "frame";
            positions: Float32Array;
            frame: number;
            lockedId: string | null;
            activeNodes: number;
            activeLinks: number;
            transferredNodes: number;
            simulatedNodes: number;
            simulatedLinks: number;
            physicsFps: number;
            nodeIndices: Uint32Array;
          }
        | { type: "status"; state: "dragging" | "settling" | "settled" }
      >,
    ) => {
      if (event.data.type === "progress") {
        layoutPreviewSinkRef.current?.({
          nodeIndices: event.data.nodeIndices,
          positions: event.data.positions,
        });
        setLayoutProgress({
          tick: event.data.tick,
          totalTicks: event.data.totalTicks,
          revealedNodes: event.data.revealedNodes,
        });
        return;
      }
      if (event.data.type === "frame") {
        positionSinkRef.current?.({
          nodeIndices: event.data.nodeIndices,
          positions: event.data.positions,
          lockedId: event.data.lockedId,
        });
        if (showMetrics && (event.data.frame % 6 === 0 || event.data.activeNodes === 0)) {
          setPhysicsFrames(event.data.frame);
          setActiveParticles(event.data.activeNodes);
          setActiveLinks(event.data.activeLinks);
          setTransferredNodes(event.data.transferredNodes);
          setSimulatedNodes(event.data.simulatedNodes);
          setSimulatedLinks(event.data.simulatedLinks);
          setPhysicsFps(event.data.physicsFps);
        }
        return;
      }
      if (event.data.type === "status") {
        if (showMetrics && event.data.state === "dragging") {
          setPhysicsFrames(0);
          setActiveParticles(0);
          setActiveLinks(0);
          setTransferredNodes(0);
          setSimulatedNodes(0);
          setSimulatedLinks(0);
          setPhysicsFps(0);
        }
        if (showMetrics) setPhysicsState(event.data.state);
        return;
      }
      const result = event.data;
      if (showMetrics) setLayoutTicks(result.layoutTicks);
      const completeLayout = () => {
        layoutCompleteSinkRef.current?.();
        setLayoutMs(result.layoutMs);
      };
      if (revealTransitionMs === 0) completeLayout();
      else completionTimer = setTimeout(completeLayout, revealTransitionMs);
    };
    worker.postMessage({
      type: "init",
      nodes: workerGraph.nodes,
      links: workerGraph.links,
      width: LAYOUT_WIDTH,
      height: LAYOUT_HEIGHT,
      collisionGap: workerGraph.collisionGap,
    });
    return () => {
      if (completionTimer) clearTimeout(completionTimer);
      workerRef.current = null;
      worker.terminate();
    };
  }, [showMetrics, workerGraph]);

  return (
    <div className={production ? "graph-canvas-stage" : "graph-scale-stage"}>
      <CanvasRenderer
        data={data}
        nodes={fallback}
        onMetrics={updateMetrics}
        onNodeDrag={dragNode}
        onSelect={onSelect}
        registerGraphInstance={registerGraphInstance}
        registerPositionSink={registerPositionSink}
        layoutPending
        registerLayoutPreviewSink={registerLayoutPreviewSink}
        registerLayoutCompleteSink={registerLayoutCompleteSink}
        production={production}
      />
      <div
        className={`graph-scale-layout-curtain${layoutMs === null ? "" : " graph-scale-layout-curtain-ready"}`}
        role="status"
        aria-live="polite"
        aria-hidden={layoutMs !== null}
        aria-label={`Settling memory field, ${layoutProgress.revealedNodes} of ${data.nodes.length} Memories`}
      >
        <div className="graph-scale-layout-loader">
          <span className="graph-scale-layout-spinner" aria-hidden="true" />
          <div>
            <strong>Settling memory field</strong>
          </div>
          <span className="graph-scale-layout-progress" aria-hidden="true">
            <span
              style={{
                width: `${
                  data.nodes.length > 0
                    ? (layoutProgress.revealedNodes / data.nodes.length) * 100
                    : 0
                }%`,
              }}
            />
          </span>
        </div>
      </div>
      {showMetrics ? (
        <div className="graph-scale-render-state">
          <span>
            {layoutMs === null
              ? `worker tick ${layoutProgress.tick}/${layoutProgress.totalTicks || "—"}`
              : physicsState === "settled"
                ? "particles settled"
                : `particles ${physicsState}`}
          </span>
          <span>{layoutMs === null ? "main thread free" : `${layoutMs.toFixed(0)}ms layout`}</span>
          <span>{layoutTicks === null ? "— ticks" : `${layoutTicks} layout ticks`}</span>
          <span>
            {MIN_COLLISION_RADIUS}–{MAX_COLLISION_RADIUS}px collision
          </span>
          <span>{physicsFrames} physics frames</span>
          <span>{physicsFps.toFixed(0)} physics fps</span>
          <span>{activeParticles} active particles</span>
          <span>{activeLinks} influencing links</span>
          <span>{simulatedNodes} simulated nodes</span>
          <span>{simulatedLinks} simulated links</span>
          <span>{transferredNodes} position deltas/frame</span>
          <span>{metrics.drawMs.toFixed(1)}ms draw</span>
          <span>{metrics.renderedNodes.toLocaleString()} visible nodes</span>
          <span>{metrics.renderedLinks.toLocaleString()} visible links</span>
          <span>{metrics.frames} frames</span>
        </div>
      ) : null}
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
          <h1>
            {data
              ? `${data.nodes.length.toLocaleString()} Memories · ${data.links.length.toLocaleString()} Links`
              : "Graph scale benchmark"}
          </h1>
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
