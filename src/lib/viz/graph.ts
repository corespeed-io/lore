import * as d3 from "d3";
import { TYPE_COLORS } from "../colors";
import type { GraphData, GraphLink } from "../types";

export function degrees(links: GraphLink[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const l of links) {
    d[l.source] = (d[l.source] ?? 0) + 1;
    d[l.target] = (d[l.target] ?? 0) + 1;
  }
  return d;
}

export interface LabelBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface LabelPlacement extends LabelBox {
  anchor: "end" | "middle" | "start";
  x: number;
  y: number;
}

export function graphLabelText(label: string, max = 32): string {
  if (label.length <= max) return label;
  const head = label.slice(0, max - 3).trimEnd();
  const boundary = head.lastIndexOf(" ");
  return `${boundary > max * 0.55 ? head.slice(0, boundary) : head}...`;
}

export function labelBoxesOverlap(a: LabelBox, b: LabelBox, pad = 0): boolean {
  return a.x0 - pad < b.x1 && a.x1 + pad > b.x0 && a.y0 - pad < b.y1 && a.y1 + pad > b.y0;
}

export interface GraphInstance {
  destroy(): void;
  fit(): void;
  highlight(ids: Set<string> | null): void;
  resetZoom(): void;
  select(id: string | null): void;
  zoomIn(): void;
  zoomOut(): void;
}

export function mountGraph(
  el: HTMLElement,
  data: GraphData,
  opts: { onSelect: (slug: string | null) => void },
): GraphInstance {
  let W = Math.max(320, el.clientWidth || 640);
  let H = Math.max(320, el.clientHeight || 460);
  const C = TYPE_COLORS;
  const linkColor = "#ebebeb";
  const nodeStroke = "#ffffff";
  const labelFill = "#171717";
  const labelHeight = 13;
  const labelGap = 7;

  const deg = degrees(data.links);
  const nodes = data.nodes.map((n) => ({ ...n })) as (GraphData["nodes"][number] &
    d3.SimulationNodeDatum)[];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
  for (const n of nodes) (n as any).r = 4 + Math.min(12, (deg[n.id] ?? 0) * 1.1);
  const links = data.links.map((l) => ({ ...l })) as (GraphLink &
    d3.SimulationLinkDatum<(typeof nodes)[number]>)[];

  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
  const view = svg.append("g"); // zoom/pan target
  const link = view
    .append("g")
    .attr("stroke", linkColor)
    .attr("stroke-width", 1)
    .selectAll("line")
    .data(links)
    .join("line");
  const linkHit = view
    .append("g")
    .attr("stroke", "transparent")
    .attr("stroke-linecap", "round")
    .attr("stroke-width", 14)
    .selectAll("line")
    .data(links)
    .join("line")
    .style("cursor", "default")
    .style("pointer-events", "stroke");
  const node = view
    .append("g")
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .attr("r", (d: any) => d.r)
    .attr("fill", (d) => C[d.type] ?? C.concept ?? "#8f8f8f")
    .attr("stroke", nodeStroke)
    .attr("stroke-width", 1.5)
    .style("cursor", "pointer");
  const label = view
    .append("g")
    .selectAll("text")
    .data(nodes)
    .join("text")
    .text((d) => graphLabelText(d.label))
    .attr("font-size", 10.5)
    .attr("fill", labelFill)
    .attr("dominant-baseline", "middle")
    .style("pointer-events", "none")
    .style("paint-order", "stroke")
    .style("stroke", nodeStroke)
    .style("stroke-width", "3px")
    .attr("opacity", 0);
  const edgeTooltip = d3
    .select(el)
    .append("div")
    .attr("class", "graph-edge-tooltip")
    .attr("aria-hidden", "true");

  const adj: Record<string, Set<string>> = {};
  for (const n of nodes) adj[n.id] = new Set([n.id]);
  for (const l of data.links) {
    adj[l.source].add(l.target);
    adj[l.target].add(l.source);
  }

  // ── Highlight an explicit id set (persists under hover) ────────────────────
  let active: Set<string> | null = null;
  let hover: Set<string> | null = null;
  let selectedId: string | null = null;
  let hoverNodeId: string | null = null;
  let hoverClearTimer: ReturnType<typeof setTimeout> | null = null;

  // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
  function endpointId(value: any): string {
    return typeof value === "string" ? value : value?.id;
  }

  // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
  function linkEndpointIds(l: any): [string, string] {
    return [endpointId(l.source), endpointId(l.target)];
  }

  function labelForNode(id: string): string {
    return nodeById.get(id)?.label ?? id;
  }

  // biome-ignore lint/suspicious/noExplicitAny: D3 event/link typing is intentionally loose here.
  function moveEdgeTooltip(event: any, l: any) {
    const [source, target] = linkEndpointIds(l);
    const rect = el.getBoundingClientRect();
    edgeTooltip
      .text(`${labelForNode(source)} -> ${labelForNode(target)}`)
      .style("opacity", "1")
      .style(
        "transform",
        `translate(${event.clientX - rect.left + 12}px, ${event.clientY - rect.top + 12}px)`,
      );
  }

  function hideEdgeTooltip() {
    edgeTooltip.style("opacity", "0");
  }

  function clearHoverTimer() {
    if (!hoverClearTimer) return;
    clearTimeout(hoverClearTimer);
    hoverClearTimer = null;
  }

  // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
  function edgeTouchesNode(l: any, id: string): boolean {
    const [source, target] = linkEndpointIds(l);
    return source === id || target === id;
  }

  function clearHoverNow() {
    clearHoverTimer();
    hoverNodeId = null;
    hover = null;
    hideEdgeTooltip();
    applyState();
  }

  function clearHoverSoon() {
    clearHoverTimer();
    hoverClearTimer = setTimeout(clearHoverNow, 110);
  }

  function labelPlacements(d: (typeof nodes)[number]): LabelPlacement[] {
    const x = d.x ?? W / 2;
    const y = d.y ?? H / 2;
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    const r = ((d as any).r ?? 8) as number;
    const textWidth = Math.min(170, graphLabelText(d.label).length * 5.55);
    const verticalBox = (labelY: number): LabelPlacement => ({
      anchor: "middle",
      x,
      y: labelY,
      x0: x - textWidth / 2 - 2,
      x1: x + textWidth / 2 + 2,
      y0: labelY - labelHeight / 2 - 2,
      y1: labelY + labelHeight / 2 + 2,
    });
    const horizontalBox = (side: -1 | 1, dy = 0): LabelPlacement => {
      const labelX = x + side * (r + labelGap);
      const labelY = y + dy;
      return {
        anchor: side > 0 ? "start" : "end",
        x: labelX,
        y: labelY,
        x0: side > 0 ? labelX - 2 : labelX - textWidth - 2,
        x1: side > 0 ? labelX + textWidth + 2 : labelX + 2,
        y0: labelY - labelHeight / 2 - 2,
        y1: labelY + labelHeight / 2 + 2,
      };
    };
    const preferredSide: -1 | 1 = x > W * 0.56 ? -1 : 1;
    const otherSide = (preferredSide * -1) as -1 | 1;
    return [
      horizontalBox(preferredSide),
      horizontalBox(otherSide),
      verticalBox(y - r - labelGap),
      verticalBox(y + r + labelGap),
      horizontalBox(preferredSide, -labelHeight),
      horizontalBox(preferredSide, labelHeight),
      horizontalBox(otherSide, -labelHeight),
      horizontalBox(otherSide, labelHeight),
    ];
  }

  function layoutLabels() {
    const selectedFocus = selectedId ? (adj[selectedId] ?? new Set([selectedId])) : null;
    const focus = hover ?? selectedFocus ?? active;
    const minDegree = focus ? 1 : nodes.length > 64 ? 3 : nodes.length > 40 ? 2 : 1;
    const boxes: LabelBox[] = [];
    const placements = new Map<string, LabelPlacement>();
    const visible = new Set<string>();
    const candidates = [...nodes]
      .filter((n) => (focus ? focus.has(n.id) : (deg[n.id] ?? 0) >= minDegree))
      .sort((a, b) => (deg[b.id] ?? 0) - (deg[a.id] ?? 0));

    for (const candidate of candidates) {
      const box = labelPlacements(candidate).find((placement) =>
        boxes.every((existing) => !labelBoxesOverlap(placement, existing, focus ? 0.5 : 2)),
      );
      if (!box) continue;
      boxes.push(box);
      placements.set(candidate.id, box);
      visible.add(candidate.id);
    }

    label
      .attr("x", (d) => (placements.get(d.id) ?? labelPlacements(d)[0]).x)
      .attr("y", (d) => (placements.get(d.id) ?? labelPlacements(d)[0]).y)
      .attr("text-anchor", (d) => (placements.get(d.id) ?? labelPlacements(d)[0]).anchor)
      .attr("opacity", (d) => (visible.has(d.id) ? 1 : 0));
  }

  function paintDefault() {
    node.attr("opacity", 1).attr("stroke", nodeStroke).attr("stroke-width", 1.5);
    link.attr("opacity", 1).attr("stroke", linkColor).attr("stroke-width", 1);
    layoutLabels();
  }
  function paintHighlight() {
    const M = active ?? new Set<string>();
    node
      .attr("opacity", (d) => (M.has(d.id) ? 1 : 0.1))
      .attr("stroke", (d) => (M.has(d.id) ? labelFill : nodeStroke))
      .attr("stroke-width", (d) => (M.has(d.id) ? 2 : 1.5));
    link
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      .attr("opacity", (l: any) => (M.has(l.source.id) && M.has(l.target.id) ? 0.9 : 0.04))
      .attr("stroke", linkColor)
      .attr("stroke-width", 1);
    layoutLabels();
  }
  function applyState() {
    if (selectedId) paintSelectedNode(selectedId);
    else if (active) paintHighlight();
    else paintDefault();
  }

  function paintNodeFocus(id: string, selected: boolean) {
    const A = adj[id] ?? new Set([id]);
    const nodeColor = C[nodeById.get(id)?.type ?? ""] ?? C.concept ?? labelFill;
    node
      .attr("opacity", (n) => (A.has(n.id) ? 1 : 0.12))
      .attr("stroke", (n) => (selected && n.id === id ? labelFill : nodeStroke))
      .attr("stroke-width", (n) => (selected && n.id === id ? 2.4 : 1.5));
    link
      // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
      .attr("opacity", (l: any) => (edgeTouchesNode(l, id) ? 0.9 : 0.05))
      // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
      .attr("stroke", (l: any) => (edgeTouchesNode(l, id) ? nodeColor : linkColor))
      // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
      .attr("stroke-width", (l: any) => (edgeTouchesNode(l, id) ? (selected ? 1.9 : 1.6) : 1));
    layoutLabels();
  }

  function paintNodeHover(id: string) {
    hover = adj[id] ?? new Set([id]);
    paintNodeFocus(id, false);
  }

  function paintSelectedNode(id: string) {
    hover = null;
    hoverNodeId = null;
    hideEdgeTooltip();
    paintNodeFocus(id, true);
  }

  // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
  function paintEdgeHover(l: any) {
    const [source, target] = linkEndpointIds(l);
    const ids = new Set([source, target]);
    hover = ids;
    node.attr("opacity", (n) => (ids.has(n.id) ? 1 : 0.12));
    link
      // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
      .attr("opacity", (edge: any) => {
        const [edgeSource, edgeTarget] = linkEndpointIds(edge);
        return edgeSource === source && edgeTarget === target ? 1 : 0.05;
      })
      // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
      .attr("stroke", (edge: any) => {
        const [edgeSource, edgeTarget] = linkEndpointIds(edge);
        return edgeSource === source && edgeTarget === target ? labelFill : linkColor;
      })
      // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
      .attr("stroke-width", (edge: any) => {
        const [edgeSource, edgeTarget] = linkEndpointIds(edge);
        return edgeSource === source && edgeTarget === target ? 1.8 : 1;
      });
    layoutLabels();
  }

  let tickCount = 0;
  const sim = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(links)
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .id((d: any) => d.id)
        .distance(78)
        .strength(0.25),
    )
    // Sparse look = collide gap (r+13) >> node radius. Charge stays low so the cloud
    // doesn't explode; x/y gently center it. Pan/zoom frames it — no hard clamp.
    .force("charge", d3.forceManyBody().strength(-180))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("x", d3.forceX(W / 2).strength(0.05))
    .force("y", d3.forceY(H / 2).strength(0.07))
    .force(
      "collide",
      d3
        .forceCollide()
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .radius((d: any) => d.r + 13),
    )
    .on("tick", () => {
      link
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("x1", (d: any) => d.source.x)
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("y1", (d: any) => d.source.y)
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("x2", (d: any) => d.target.x)
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("y2", (d: any) => d.target.y);
      linkHit
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("x1", (d: any) => d.source.x)
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("y1", (d: any) => d.source.y)
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("x2", (d: any) => d.target.x)
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("y2", (d: any) => d.target.y);
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      node.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);
      layoutLabels();
      if (++tickCount === 70) fitView(); // frame once the layout has settled
    });

  node.call(
    d3
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      .drag<any, any>()
      .on("start", (e, d) => {
        e.sourceEvent?.stopPropagation?.(); // don't let the pan gesture also fire
        if (!e.active) sim.alphaTarget(0.3).restart(); // reheat → springs on drag
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (e, d) => {
        d.fx = e.x;
        d.fy = e.y;
      })
      .on("end", (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }),
  );

  node
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .on("pointerover", (_e, d: any) => {
      if (selectedId) return;
      clearHoverTimer();
      hideEdgeTooltip();
      hoverNodeId = d.id;
      paintNodeHover(d.id);
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .on("pointermove", (_e, d: any) => {
      if (selectedId) return;
      if (hoverNodeId === d.id) return;
      clearHoverTimer();
      hideEdgeTooltip();
      hoverNodeId = d.id;
      paintNodeHover(d.id);
    })
    .on("pointerout", () => {
      if (selectedId) return;
      clearHoverSoon();
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .on("click", (event, d: any) => {
      event.stopPropagation();
      clearHoverTimer();
      selectedId = d.id;
      applyState();
      opts.onSelect(d.id);
    });

  linkHit
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    .on("pointerover", (event, l: any) => {
      clearHoverTimer();
      if (selectedId) {
        applyState();
        return;
      }
      if (hoverNodeId && edgeTouchesNode(l, hoverNodeId)) {
        hideEdgeTooltip();
        paintNodeHover(hoverNodeId);
      } else {
        hoverNodeId = null;
        paintEdgeHover(l);
        moveEdgeTooltip(event, l);
      }
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    .on("pointermove", (event, l: any) => {
      if (selectedId) {
        hideEdgeTooltip();
        return;
      }
      if (hoverNodeId && edgeTouchesNode(l, hoverNodeId)) {
        hideEdgeTooltip();
        return;
      }
      moveEdgeTooltip(event, l);
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    .on("pointerout", (_event, l: any) => {
      hideEdgeTooltip();
      if (selectedId) return;
      if (hoverNodeId && edgeTouchesNode(l, hoverNodeId)) {
        clearHoverSoon();
        return;
      }
      clearHoverNow();
    });

  // ── Pan / zoom: wheel zooms, dragging empty space pans, nodes drag themselves;
  // double-click re-fits the whole graph to the viewport. ──────────────────────
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 4])
    // biome-ignore lint/suspicious/noExplicitAny: d3 zoom event
    .filter((event: any) => {
      // Wheel is handled by the smooth listener below (animated, not per-tick).
      if (event.type === "wheel") return false;
      if (event.button) return false;
      // pan only from empty space; let node-drag own pointer-downs on circles
      return !(event.target as Element)?.closest?.("circle");
    })
    // biome-ignore lint/suspicious/noExplicitAny: d3 zoom event
    .on("zoom", (event: any) => view.attr("transform", event.transform));
  svg.call(zoom).on("dblclick.zoom", null);

  // Smooth wheel zoom: animate each step toward the cursor over a short
  // interruptible transition, so rapid notches glide instead of stepping.
  svg.on("wheel.smooth", (event: WheelEvent) => {
    if (event.ctrlKey) return; // let the browser pinch-zoom the page
    event.preventDefault();
    const factor = 2 ** (-event.deltaY * 0.002);
    const p = d3.pointer(event, svg.node());
    svg.transition("zoom").duration(140).ease(d3.easeCubicOut).call(zoom.scaleBy, factor, p);
  });

  function fitView() {
    if (!nodes.length) return;
    // biome-ignore lint/suspicious/noExplicitAny: d3 node datum
    const ns = nodes as any[];
    const minX = Math.min(...ns.map((n) => n.x));
    const maxX = Math.max(...ns.map((n) => n.x));
    const minY = Math.min(...ns.map((n) => n.y));
    const maxY = Math.max(...ns.map((n) => n.y));
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const pad = 60;
    const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 1.5);
    const tx = W / 2 - (scale * (minX + maxX)) / 2;
    const ty = H / 2 - (scale * (minY + maxY)) / 2;
    svg
      .transition()
      .duration(450)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }
  svg.on("dblclick", () => fitView());

  function zoomBy(scale: number) {
    svg.transition().duration(180).call(zoom.scaleBy, scale);
  }

  function resetZoom() {
    svg.transition().duration(180).call(zoom.transform, d3.zoomIdentity);
  }

  // Keep the graph sized to its container (window resize, panel changes) instead of
  // freezing at mount-time dimensions.
  const ro = new ResizeObserver(() => {
    const nw = Math.max(320, el.clientWidth || W);
    const nh = Math.max(320, el.clientHeight || H);
    if (nw === W && nh === H) return;
    W = nw;
    H = nh;
    svg.attr("width", W).attr("height", H);
    sim.force("center", d3.forceCenter(W / 2, H / 2));
    // biome-ignore lint/suspicious/noExplicitAny: d3 force accessor typing
    (sim.force("x") as any).x(W / 2);
    // biome-ignore lint/suspicious/noExplicitAny: d3 force accessor typing
    (sim.force("y") as any).y(H / 2);
    sim.alpha(0.3).restart();
    fitView();
  });
  ro.observe(el);

  return {
    destroy() {
      ro.disconnect();
      sim.stop();
      clearHoverTimer();
      edgeTooltip.remove();
      svg.remove();
    },
    fit() {
      fitView();
    },
    highlight(ids: Set<string> | null) {
      active = ids;
      if (!hover) applyState();
      else layoutLabels();
    },
    resetZoom,
    select(id: string | null) {
      selectedId = id;
      clearHoverTimer();
      hover = null;
      hoverNodeId = null;
      applyState();
    },
    zoomIn() {
      zoomBy(1.25);
    },
    zoomOut() {
      zoomBy(0.8);
    },
  };
}
