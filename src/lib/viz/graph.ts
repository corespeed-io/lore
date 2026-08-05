import * as d3 from "d3";
import { typeColor } from "../colors";
import type { MemoryGraph as GraphData, MemoryGraphLink as GraphLink } from "../graph";

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

// A repaint shows `shown` and must hide whatever was on screen before and no
// longer is. Returning that set — rather than "everything not shown" — is the
// whole point: at rest 626 of 696 labels are ALREADY hidden, and an opacity
// write to one of those changes nothing while costing the same as a real one.
//
// Extracted because the two ways to get this wrong fail in opposite directions
// and neither is visible in review. Widening it to every not-shown label is a
// silent 30x write amplification that looks identical on screen. Dropping the
// second half leaves labels from the PREVIOUS hover on screen — a visual bug,
// but only for whoever happens to be moving a pointer at the time.
// Where a post-drag focus hold ends, decided from the first REAL pointer
// travel after release. Pure and exported for the same reason labelsToHide is:
// the threat — "during the hold, nothing that MOVES under a stationary pointer
// may take the focus, and the hold ends only by pointer travel" — has to be
// testable without a browser. The travel threshold (6px, squared) absorbs
// release jitter; where the pointer lands decides what happens to the focus:
// a circle or an edge INCIDENT to the held focus keeps it (the ordinary hover
// path keeps it there too), anything else clears.
export type HoldTarget = "circle" | "incident-edge" | "other";
export function holdVerdict(
  travelSq: number,
  target: HoldTarget,
): "hold" | "release" | "release-clear" {
  if (travelSq < 36) return "hold";
  return target === "circle" || target === "incident-edge" ? "release" : "release-clear";
}

export function labelsToHide(
  wasShown: Iterable<string>,
  shown: { has(id: string): boolean },
): Set<string> {
  const hide = new Set<string>();
  for (const id of wasShown) if (!shown.has(id)) hide.add(id);
  return hide;
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
  opts: { onSelect: (memoryId: string | null) => void },
): GraphInstance {
  let W = Math.max(320, el.clientWidth || 640);
  let H = Math.max(320, el.clientHeight || 460);
  // Colours live in globals.css under `.lore-graph` now — the stylesheet is the
  // paint table. Only layout numbers remain here.
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

  // Styling lives in globals.css under `.lore-graph` — the stylesheet is the
  // paint table, JS only assigns membership classes (.match/.lit/.hovered) and
  // geometry. Groups are class-scoped because SVG stroke inherits: a bare
  // `line` rule would paint the transparent hit layer's lines visible.
  const svg = d3
    .select(el)
    .append("svg")
    .attr("class", "lore-graph")
    .attr("width", W)
    .attr("height", H);
  const view = svg.append("g"); // zoom/pan target
  const link = view.append("g").attr("class", "glinks").selectAll("line").data(links).join("line");
  // ponytail: the edge-hover hit layer is a 14px transparent copy of EVERY edge,
  // so it doubles the line count and the per-tick attribute writes. At 1733
  // edges that is 3466 <line> elements and 15,256 attribute writes per tick.
  // Past this many edges the 14px strokes overlap each other so heavily that
  // picking one edge is not a real interaction, so it is not drawn at all: an
  // empty data join leaves the selection valid and every .attr()/.on() below a
  // no-op, with no branch to keep in sync. Upgrade path: draw to a canvas and
  // hit-test in code — note that `simulation.find` is a LINEAR scan over every
  // node (d3-force/src/simulation.js:128), not a quadtree lookup; the quadtree
  // d3-force builds is rebuilt per tick inside the charge force and is not
  // exposed. A linear scan is fine at this size, but do not plan around an
  // index that does not exist.
  const EDGE_HOVER_LIMIT = 600;
  const linkHit = view
    .append("g")
    .attr("class", "ghits")
    .attr("stroke", "transparent")
    .attr("stroke-linecap", "round")
    .attr("stroke-width", 14)
    .selectAll("line")
    .data(links.length <= EDGE_HOVER_LIMIT ? links : [])
    .join("line");
  const node = view
    .append("g")
    .attr("class", "gnodes")
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .attr("r", (d: any) => d.r)
    // fill stays an attribute: it is per-node dynamic (type palette), set once.
    .attr("fill", (d) => typeColor(d.type));
  const label = view
    .append("g")
    .attr("class", "glabels")
    .selectAll("text")
    .data(nodes)
    .join("text")
    .text((d) => graphLabelText(d.label))
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
  // What is currently LIT, so the next paint can put exactly that back. Since no
  // paint dims the whole graph any more, nothing does a blanket restore, and a
  // transition that forgets to undo its predecessor leaves visible residue —
  // a graph stuck half-dimmed, or two neighbourhoods lit at once.
  //
  // It is ONE descriptor for every kind of focus (a node's neighbourhood, a
  // single edge) precisely because two independent reset paths is how that
  // residue survives: paintEdgeHover used to dim everything and knew nothing
  // about the node focus, so hovering a node, then an edge, then the SAME node
  // left the dim painted with no code left to remove it.
  //
  // `touching` is a predicate rather than a set so an edge focus can say "this
  // exact pair" and a node focus "anything incident to this id" without either
  // list being materialised.
  // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
  type Lit = { nodes: Set<string>; touching: (l: any) => boolean };
  let lit: Lit | null = null;

  // Pure membership removal. There is deliberately NO restore logic here: the
  // base look — including a search match's ring — is the stylesheet's, so
  // removing the classes IS the restore. The bug family this file kept
  // re-fixing (clearing to the wrong base, erasing search rings mid-sweep)
  // existed because attribute writes are absolute and the clearer had to know
  // what the base was. Classes compose; the clearer no longer knows anything.
  function clearLit() {
    if (!lit) return;
    const was = lit;
    lit = null;
    node.filter((n) => was.nodes.has(n.id)).classed("lit hovered", false);
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    link.filter((l: any) => was.touching(l)).classed("lit exact", false);
  }

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

  // The dim is back, but as ONE class on the svg root — CSS dims every element,
  // and the lit neighbourhood opts out via `.lit` (see globals.css). What was
  // removed before was never the look; it was writing opacity onto 2400
  // elements per pointermove. A class flip is one write; the browser's style
  // pass does the rest.
  //
  // Engaged on DWELL, not on entry: dimming repaints every pixel of the layer,
  // and doing that for every node a sweeping pointer crosses is exactly the
  // per-frame full-raster this file spent a week removing. Rings light
  // instantly while sweeping; resting on a node for DIM_DWELL_MS fades the rest
  // of the graph back. Once engaged, moving between nodes keeps it engaged —
  // the dwell gates entry, not continuation. A click dims immediately:
  // selection is deliberate.
  const DIM_DWELL_MS = 150;
  let dimTimer: ReturnType<typeof setTimeout> | null = null;
  let dimOn = false;

  function cancelDimTimer() {
    if (!dimTimer) return;
    clearTimeout(dimTimer);
    dimTimer = null;
  }
  function dimNow() {
    cancelDimTimer();
    if (dimOn) return;
    dimOn = true;
    svg.classed("graph-dimmed", true);
  }
  function armDim() {
    if (dimOn) return; // already engaged — a move between nodes keeps it
    cancelDimTimer();
    dimTimer = setTimeout(dimNow, DIM_DWELL_MS);
  }
  function undim() {
    cancelDimTimer();
    if (!dimOn) return;
    dimOn = false;
    svg.classed("graph-dimmed", false);
  }

  // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
  function edgeTouchesNode(l: any, id: string): boolean {
    const [source, target] = linkEndpointIds(l);
    return source === id || target === id;
  }

  function clearHoverNow() {
    clearHoverTimer();
    cancelHoverPaint(); // a queued frame would repaint the focus we are clearing
    undim(); // applyState below re-dims immediately if a selection is active
    hoverNodeId = null;
    hover = null;
    hideEdgeTooltip();
    applyState();
  }

  function clearHoverSoon() {
    clearHoverTimer();
    hoverClearTimer = setTimeout(clearHoverNow, 110);
  }

  // ponytail: a hover repaint costs what it costs; what was unbounded is how
  // OFTEN one was asked for. pointermove arrives about every 8ms, every node the
  // pointer crosses asked for a full repaint, and a repaint that dims 690 nodes
  // and 1729 edges does not finish in 8ms — so sweeping the pointer across the
  // graph queued work faster than it could ever drain, and the lag was the
  // backlog rather than any single paint. Coalescing to one paint per animation
  // frame caps the rate at the display's, which is the most repaints that can
  // ever be seen. hoverNodeId is still assigned SYNCHRONOUSLY, so the
  // same-node early return and the pointerout ownership check keep working off
  // the real pointer position rather than a frame-old copy.
  let hoverFrame = 0;
  function paintHoverSoon() {
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      if (selectedId || !hoverNodeId) return;
      paintNodeHover(hoverNodeId);
    });
  }
  function cancelHoverPaint() {
    if (!hoverFrame) return;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = 0;
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

  // Which labels the last collision pass chose to show, and where. Kept so the
  // cheap per-frame pass can move them without redeciding.
  let labelVisible = new Set<string>();
  // ...and WHICH of the eight candidate placements each one won. positionLabels
  // used to re-derive candidate 0 for everybody, so the first tick of a drag
  // snapped every label that had settled on candidate 3 back to candidate 0 —
  // grabbing any node made all visible labels jump at once.
  let labelChoice = new Map<string, number>();

  // O(n), no collision tests: every visible label follows its node at the
  // placement the last collision pass chose for it. This is what runs on a tick.
  function positionLabels() {
    // One labelPlacements call per VISIBLE node — it allocates eight boxes, and
    // reading it from inside four .attr() callbacks called it four times per node.
    const at = new Map<string, LabelPlacement>();
    for (const n of nodes) {
      if (!labelVisible.has(n.id)) continue;
      const options = labelPlacements(n);
      at.set(n.id, options[labelChoice.get(n.id) ?? 0] ?? options[0]);
    }
    paintLabels(at);
  }

  // ponytail: writes only what changed, and it is the single writer of
  // labelVisible. Geometry goes to the SHOWN labels only — an x or y write on a
  // <text> reflows its glyphs, and at rest 626 of 696 labels are hidden while a
  // hover shows about five. Opacity goes only where visibility actually flipped,
  // so a label that was hidden and stays hidden is not touched at all.
  //
  // Measured on this graph at 696 nodes: writing all four attributes to every
  // label cost 4.5ms of a hover's 6.9ms, and pointermove arrives about every
  // 8ms, so sweeping the pointer across the graph could never keep up.
  function paintLabels(at: Map<string, LabelPlacement>) {
    const hide = labelsToHide(labelVisible, at);
    labelVisible = new Set(at.keys());
    label
      .filter((d) => at.has(d.id))
      .attr("opacity", 1)
      .attr("x", (d) => at.get(d.id)?.x ?? 0)
      .attr("y", (d) => at.get(d.id)?.y ?? 0)
      .attr("text-anchor", (d) => at.get(d.id)?.anchor ?? "middle");
    label.filter((d) => hide.has(d.id)).attr("opacity", 0);
  }

  // ponytail: O(n²) in overlap tests — at ~1000 nodes this is ~470k rect tests
  // plus ~40k allocations, which is why it must never run on a tick. Verified in
  // the browser at 973 nodes / 2205 edges: per-tick, frames exceeded 300ms and
  // the renderer stopped answering at all. It runs on settle and on interaction
  // (hover, select, highlight) — the moments the placement can actually change —
  // and positionLabels() carries the labels in between. Upgrade path if a brain
  // gets far larger: a grid index instead of the linear `boxes` scan.
  function layoutLabels() {
    const selectedFocus = selectedId ? (adj[selectedId] ?? new Set([selectedId])) : null;
    const focus = hover ?? selectedFocus ?? active;
    const minDegree = focus ? 1 : nodes.length > 64 ? 3 : nodes.length > 40 ? 2 : 1;
    const boxes: LabelBox[] = [];
    const placements = new Map<string, LabelPlacement>();
    const candidates = [...nodes]
      .filter((n) => (focus ? focus.has(n.id) : (deg[n.id] ?? 0) >= minDegree))
      .sort((a, b) => (deg[b.id] ?? 0) - (deg[a.id] ?? 0));

    const choices = new Map<string, number>();
    for (const candidate of candidates) {
      const options = labelPlacements(candidate);
      const idx = options.findIndex((placement) =>
        boxes.every((existing) => !labelBoxesOverlap(placement, existing, focus ? 0.5 : 2)),
      );
      if (idx < 0) continue;
      boxes.push(options[idx]);
      placements.set(candidate.id, options[idx]);
      choices.set(candidate.id, idx);
    }
    labelChoice = choices;
    // paintLabels owns labelVisible and derives it from these keys — tracking a
    // second `visible` set here would give that state two writers.
    paintLabels(placements);
  }

  // The one non-selected reset. `.match` is deliberately NOT touched here —
  // highlight() below is its single writer, so the search rings hold across
  // every route, including selection. (They didn't: paintNodeFocus never wrote
  // .match and applyState routes to it whenever a node is selected, so
  // search -> click a node -> clear the search left the rings painted with no
  // writer left to remove them — the residue family the class model exists to
  // kill, reintroduced by having two reset paints that each knew half the
  // state. Now there is one.)
  function paintBase() {
    lit = null; // the membership resets below cover whatever was lit
    undim(); // search marks its matches; it does not dim (asked for explicitly)
    svg.classed("gsel", false);
    node.classed("lit hovered", false);
    link.classed("lit exact", false);
    layoutLabels();
  }
  function applyState() {
    if (selectedId) paintSelectedNode(selectedId);
    else paintBase();
  }

  // The last full-graph repaint, and the one that was actually being felt. To
  // point at a neighbourhood of a few dozen elements it pushed ~680 nodes to
  // opacity 0.12 and ~1700 edges to 0.05 — every element in the picture changed
  // on every pointer move, so the browser re-rendered the whole SVG layer each
  // time. Now the neighbourhood LIGHTS UP and nothing else is touched: writes
  // drop from ~7300 to roughly twice the hovered node's degree.
  //
  // Which means the previous focus has to be put back by hand — clearLit() above
  // is the single place that does it, and it runs BEFORE the new light, so a node
  // in both neighbourhoods ends up lit rather than reset.
  //
  // The hovered node gains a ring it did not have before (2.2, against 2.4 for a
  // selected one). Losing the dim costs contrast, and the ring plus the tinted
  // incident edges plus the labels have to carry the emphasis alone.
  function paintNodeFocus(id: string, selected: boolean) {
    const A = adj[id] ?? new Set([id]);
    const nodeColor = typeColor(nodeById.get(id)?.type ?? "");
    clearLit();
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    lit = { nodes: A, touching: (l: any) => edgeTouchesNode(l, id) };
    // One property write carries the tint to every incident edge via CSS;
    // .gsel on the root is what widens the hovered ring and edges when the
    // focus is a selection rather than a hover.
    svg.style("--focus-tint", nodeColor).classed("gsel", selected);
    node
      .filter((n) => A.has(n.id))
      .classed("lit", true)
      .classed("hovered", (n) => n.id === id);
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    link.filter((l: any) => edgeTouchesNode(l, id)).classed("lit", true);
    layoutLabels();
  }

  function paintNodeHover(id: string) {
    hover = adj[id] ?? new Set([id]);
    armDim();
    paintNodeFocus(id, false);
  }

  function paintSelectedNode(id: string) {
    hover = null;
    hoverNodeId = null;
    hideEdgeTooltip();
    dimNow(); // a click is deliberate — no dwell
    paintNodeFocus(id, true);
  }

  // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
  function paintEdgeHover(l: any) {
    const [source, target] = linkEndpointIds(l);
    const ids = new Set([source, target]);
    hover = ids;
    // The match stays DIRECTED and exact-pair, as it was: a reciprocal B->A edge
    // is a different edge and is not lit, and every parallel duplicate A->B is.
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    const isThisEdge = (edge: any) => {
      const [a, b] = linkEndpointIds(edge);
      return a === source && b === target;
    };
    clearLit();
    lit = { nodes: ids, touching: isThisEdge };
    // `.exact` overrides the tint: an edge picked directly is marked in ink,
    // not in either endpoint's colour. `.hovered` gives the endpoints rings.
    node.filter((n) => ids.has(n.id)).classed("lit hovered", true);
    link.filter(isThisEdge).classed("lit exact", true);
    layoutLabels();
  }

  // Write every moving coordinate into the DOM. Called per tick only while the
  // simulation is actually running — which, after the headless settle below, is
  // only during a drag.
  function drawFrame() {
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
    positionLabels();
  }

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
    .on("tick", drawFrame)
    // Once motion stops (a released drag has cooled), re-run the collision pass:
    // positionLabels carried the labels along at their OLD winning placements,
    // and the nodes have moved out from under those decisions.
    .on("end", () => layoutLabels());

  // While a node drag is live, the drag OWNS the focus: the simulation reheats
  // and the node chases the pointer, so the pointer transiently exits the
  // circle between frames — its own pointerout used to fire, and 110ms later
  // the hover (and the dim with it) vanished mid-drag, unrecoverable because
  // re-entry is gesture-guarded. Grabbing a node is the strongest focus signal
  // there is; nothing but release may take it away.
  let draggingNode = false;
  // ...and RELEASE doesn't take it away either. On release the springs pull
  // the node out from under the stationary pointer, and Chrome fires a
  // pointerout for an element that moved — not a pointer that did. The focus
  // holds after a drag until the POINTER moves: onto another node (focus
  // follows, normal path) or across empty space (clears). Stored as the
  // release coordinates; null means no hold.
  let postDragFrom: { x: number; y: number } | null = null;
  // THE guard, one expression for every pointer handler on every layer. The
  // first version guarded only the node layer — but the edge hit layer is a
  // 14px transparent copy of every edge, repositioned each tick, and its
  // unguarded handlers let a springing hit line kill or steal the focus after
  // release. Invisible on this brain: above EDGE_HOVER_LIMIT the hit layer is
  // an empty join, so only sub-600-edge deployments had the bug.
  const focusHeld = () => draggingNode || postDragFrom !== null;

  node.call(
    d3
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      .drag<any, any>()
      .on("start", (e, d) => {
        e.sourceEvent?.stopPropagation?.(); // don't let the pan gesture also fire
        if (!e.active) sim.alphaTarget(0.3).restart(); // reheat → springs on drag
        draggingNode = true;
        // Grabbing focuses and dims IMMEDIATELY — like a click, a grab is
        // deliberate; the dwell exists for sweeps, not for this. Skipped while
        // a selection is active, mirroring the hover handlers.
        if (!selectedId) {
          clearHoverTimer();
          hoverNodeId = d.id;
          paintNodeHover(d.id);
          dimNow();
        }
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (e, d) => {
        d.fx = e.x;
        d.fy = e.y;
      })
      .on("end", (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        draggingNode = false;
        // Touch end events carry no clientX — no hold there, honestly, rather
        // than a NaN origin behind a cast that asserts otherwise. And a release
        // over one of the floating overlays (legend, search, controls, node
        // preview) arms no hold either: the svg's pointerleave already fired
        // during the drag and was rightly swallowed, so with the pointer off
        // the svg nothing could ever end it — the graph stayed dimmed while
        // the user worked the toolbar.
        const src = e.sourceEvent as
          | { clientX?: number; clientY?: number; target?: Node }
          | undefined;
        const overSvg = src?.target ? (svg.node()?.contains(src.target) ?? false) : false;
        postDragFrom =
          overSvg && src && Number.isFinite(src.clientX) && Number.isFinite(src.clientY)
            ? { x: src.clientX as number, y: src.clientY as number }
            : null;
        d.fx = null;
        d.fy = null;
      }),
  );

  // The post-drag hold's release valve: the first REAL pointer travel after a
  // drag ends the hold, and where it lands decides the focus — holdVerdict is
  // the (pure, tested) rule. A hit-layer line incident to the held focus
  // counts as focus-bearing, because the ordinary edge-hover path deliberately
  // keeps node focus there too.
  svg.on("pointermove.postdrag", (event: PointerEvent) => {
    if (!postDragFrom || draggingNode) return;
    const dx = event.clientX - postDragFrom.x;
    const dy = event.clientY - postDragFrom.y;
    const el = event.target as Element | null;
    let target: HoldTarget = "other";
    if (el?.closest?.(".gnodes circle")) target = "circle";
    else {
      const hit = el?.closest?.(".ghits line");
      // biome-ignore lint/suspicious/noExplicitAny: D3 binds the datum on the element.
      const datum = hit ? (hit as any).__data__ : null;
      if (datum && hoverNodeId && edgeTouchesNode(datum, hoverNodeId)) target = "incident-edge";
    }
    const verdict = holdVerdict(dx * dx + dy * dy, target);
    if (verdict === "hold") return;
    postDragFrom = null;
    if (verdict === "release-clear") clearHoverSoon();
  });

  // Leaving the svg entirely also ends the hold — releasing near the container
  // edge and exiting used to strand the dim until the pointer came back.
  svg.on("pointerleave.postdrag", () => {
    if (!postDragFrom || draggingNode) return;
    postDragFrom = null;
    clearHoverSoon();
  });

  // A pointer with a button held down is dragging a node or panning the canvas,
  // not pointing at things — every node it crosses used to repaint the graph on
  // top of the simulation the drag itself reheated, which is the worst moment to
  // add work. Read from the event rather than tracked with a "gesturing" flag on
  // purpose: a flag that misses its end event (an interrupted zoom transition,
  // a pointer released off-window) stays stuck and kills hover for good, while
  // `buttons` cannot get out of sync with the pointer.
  //
  // Guarding the two ACQUIRE handlers is not enough, and the asymmetry is the
  // whole bug: d3-drag listens on the window, so a node the pointer merely
  // crosses mid-drag still gets its own pointerover AND pointerout from the
  // browser. Blocking only the pointerover left the pointerout to fire
  // clearHoverSoon, which 110ms later wiped the focus of the node being DRAGGED
  // — a node the pointer never left, erased by one it only passed over. So
  // during a gesture only the node that HOLDS the focus may release it.
  //
  // That check is what keeps the focus from sticking, too. A pan while hovering
  // A does leave A, so A's own pointerout still clears it; freezing hover
  // wholesale for the gesture would have left A lit with nothing under the
  // pointer and no event coming to fix it.
  // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
  const isGesture = (e: any) => Boolean(e?.buttons);

  node
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .on("pointerover", (e: any, d: any) => {
      if (selectedId || isGesture(e)) return;
      // The acquire path asks the SAME question as everything else: did the
      // POINTER travel, or did an element move under it? A circle's pointerover
      // with no travel is the springs pushing a node (this one, or a
      // neighbour) back across the stationary pointer — ending the hold there
      // re-opened the post-release dim death through the last unguarded door,
      // and contradicted holdVerdict(0, "circle") === "hold" outright.
      if (postDragFrom) {
        const dx = e.clientX - postDragFrom.x;
        const dy = e.clientY - postDragFrom.y;
        if (holdVerdict(dx * dx + dy * dy, "circle") === "hold") return;
        postDragFrom = null; // real travel onto a circle: focus follows the pointer
      }
      clearHoverTimer();
      hideEdgeTooltip();
      hoverNodeId = d.id;
      paintHoverSoon();
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .on("pointermove", (e: any, d: any) => {
      if (selectedId || isGesture(e)) return;
      // Same rule as pointerover: sub-threshold "travel" onto an overlapping
      // neighbour is jitter or element motion, never a focus change.
      if (postDragFrom) {
        const dx = e.clientX - postDragFrom.x;
        const dy = e.clientY - postDragFrom.y;
        if (holdVerdict(dx * dx + dy * dy, "circle") === "hold") return;
        postDragFrom = null;
      }
      if (hoverNodeId === d.id) return;
      clearHoverTimer();
      hideEdgeTooltip();
      hoverNodeId = d.id;
      paintHoverSoon();
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .on("pointerout", (e: any, d: any) => {
      if (selectedId) return;
      // A live node drag owns the focus outright — the dragged node's own
      // transient pointerouts (the pointer outrunning the node between frames)
      // must not clear it. After release the HOLD owns it: the node springs
      // out from under the stationary pointer and Chrome fires pointerout for
      // an element that moved, not a pointer that did. A PAN keeps the old
      // rule: leaving the held node really is leaving it.
      if (draggingNode || postDragFrom) return;
      if (isGesture(e) && hoverNodeId !== d.id) return; // a crossed node, not the held one
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

  // Every handler on this layer starts with focusHeld(): the hit lines are
  // repositioned each tick, so during a drag — and during the post-release
  // hold, while the springs are still moving — they sweep under the STATIONARY
  // pointer and fire enter/leave events for elements that moved. The first
  // version guarded only the node layer against this, and on any brain small
  // enough to have a hit layer (<= EDGE_HOVER_LIMIT edges), a springing hit
  // line killed the dim right after release or stole the focus outright.
  linkHit
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    .on("pointerover", (event, l: any) => {
      if (isGesture(event) || focusHeld()) return; // moving elements don't take focus
      clearHoverTimer();
      if (selectedId) {
        applyState();
        return;
      }
      if (hoverNodeId && edgeTouchesNode(l, hoverNodeId)) {
        hideEdgeTooltip();
        paintHoverSoon();
      } else {
        hoverNodeId = null;
        paintEdgeHover(l);
        moveEdgeTooltip(event, l);
      }
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 mutates link endpoints from ids to node objects.
    .on("pointermove", (event, l: any) => {
      if (isGesture(event) || focusHeld()) return;
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
    .on("pointerout", (_event: any, l: any) => {
      hideEdgeTooltip();
      if (selectedId) return;
      // An edge crossed mid-gesture takes the `clearHoverNow` branch below, which
      // has no 110ms coalescing at all — it would wipe the dragged node's focus
      // instantly. Same for a hit line springing off the pointer post-release.
      if (isGesture(_event) || focusHeld()) return;
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

  function fitView(animate = true) {
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
    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    // The initial framing is instant. Animating it re-renders the whole graph
    // for 450ms immediately after mount, which is the jank the headless settle
    // below exists to remove — a double-click fit still animates.
    if (!animate) svg.call(zoom.transform, t);
    else svg.transition().duration(450).call(zoom.transform, t);
  }
  svg.on("dblclick", (event: MouseEvent) => {
    // Double-clicking a NODE is two selection clicks, and flinging the viewport
    // to whole-graph fit mid-inspection discards where the user was. Fit stays
    // the double-click meaning for empty space only.
    if ((event.target as Element)?.closest?.("circle")) return;
    fitView();
  });

  function zoomBy(scale: number) {
    svg.transition().duration(180).call(zoom.scaleBy, scale);
  }

  function resetZoom() {
    svg.transition().duration(180).call(zoom.transform, d3.zoomIdentity);
  }

  // ponytail: settle the layout HEADLESSLY, then draw it once. `sim.tick(n)`
  // decays alpha per iteration and does NOT dispatch the tick event
  // (d3-force/src/simulation.js:38-59), so the entire settle costs force
  // computation and nothing else — no attribute writes, no rasterisation, no
  // frames. The animated settle it replaces was ~300 frames each writing 8324
  // coordinates and re-rendering 2400 vector elements, and hovering DURING it
  // stacked a full-graph focus repaint onto that same frame budget, which is
  // the worst case anyone reported. There is no longer a window to hover in:
  // the graph is laid out before it is first drawn.
  //
  // Bounded by TIME, not by tick count, and the ceiling is the point. 300 ticks
  // is where alphaDecay (1 - 0.001^(1/300)) stops on its own, but a tick here
  // measured ~2.6ms at 696 nodes / 1733 edges, so insisting on all 300 would
  // trade the settle animation for a ~780ms frozen main thread — a worse bug
  // than the one being fixed. So it settles as far as it can inside the budget
  // and draws whatever it reached: a not-quite-relaxed static layout is fine,
  // and the alternative (finish the rest animated) would put back the exact
  // window this removes. Ticks run in batches of 10 with the budget checked
  // BETWEEN batches, so the worst case is the budget plus one final batch
  // (~26ms) — bounded, not exact.
  // 400ms because a block DURING MOUNT is not the same defect as a block during
  // interaction: there is nothing on screen yet, so nobody can be interrupted by
  // it — it reads as the page taking slightly longer to load, on a page that
  // already waits on /api/graph. A tighter budget (150ms) bought only ~57 of the
  // 300 ticks at the measured ~2.6ms each, which draws a layout that never
  // finished spreading out. The ceiling is the point: a far bigger graph stops
  // early and looks under-relaxed rather than freezing for seconds.
  const SETTLE_TICKS = 300;
  const SETTLE_BUDGET_MS = 400;
  sim.stop(); // forceSimulation starts its timer on construction
  const settleStart = performance.now();
  let settled = 0;
  while (settled < SETTLE_TICKS && performance.now() - settleStart < SETTLE_BUDGET_MS) {
    sim.tick(10);
    settled += 10;
  }
  drawFrame();
  layoutLabels();
  fitView(false);

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
    // A resize changes the CANVAS, not the graph: re-settling shuffled node
    // positions and fitView(false) threw away the user's zoom/pan on every
    // notification — dragging a panel divider erased the frame someone had
    // navigated to. The forces above are updated so a FUTURE drag pulls toward
    // the new centre; the layout and the transform are left exactly where the
    // user had them. Labels re-decide once because side preference reads W.
    layoutLabels();
  });
  ro.observe(el);

  return {
    destroy() {
      ro.disconnect();
      sim.stop();
      clearHoverTimer();
      cancelHoverPaint();
      cancelDimTimer();
      postDragFrom = null;
      edgeTooltip.remove();
      svg.remove();
    },
    fit() {
      fitView();
    },
    highlight(ids: Set<string> | null) {
      // The view calls this once per search update. An unchanged set would
      // repaint every ring and re-run the label collision pass for nothing.
      if (ids && active && ids.size === active.size && [...ids].every((id) => active?.has(id)))
        return;
      if (!ids && !active) return;
      active = ids;
      // THE single writer of `.match`. Reconciled here, not in a route paint,
      // so the rings appear and disappear with the search whatever else is
      // going on — hover, selection, or nothing.
      const M = active ?? new Set<string>();
      node.classed("match", (d) => M.has(d.id));
      if (!hover) applyState();
      else layoutLabels();
    },
    resetZoom,
    select(id: string | null) {
      selectedId = id;
      clearHoverTimer();
      postDragFrom = null;
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
