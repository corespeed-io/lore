import * as d3 from "d3";
import type { GraphData, GraphLink } from "../types";

export function degrees(links: GraphLink[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const l of links) {
    d[l.source] = (d[l.source] ?? 0) + 1;
    d[l.target] = (d[l.target] ?? 0) + 1;
  }
  return d;
}

export function mountGraph(
  el: HTMLElement,
  data: GraphData,
  opts: { colors: Record<string, string>; onOpen: (slug: string) => void },
): { destroy(): void } {
  let W = Math.max(320, el.clientWidth || 640);
  let H = Math.max(320, el.clientHeight || 460);
  const C = opts.colors;
  const linkColor = "#cbc2b4";
  const nodeStroke = "#faf9f5";
  const labelFill = "#141413";

  const deg = degrees(data.links);
  const nodes = data.nodes.map((n) => ({ ...n })) as (GraphData["nodes"][number] &
    d3.SimulationNodeDatum)[];
  // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
  for (const n of nodes) (n as any).r = 4 + Math.min(12, (deg[n.id] ?? 0) * 1.1);
  const links = data.links.map((l) => ({ ...l })) as (GraphLink &
    d3.SimulationLinkDatum<(typeof nodes)[number]>)[];

  const svg = d3.select(el).append("svg").attr("width", W).attr("height", H);
  const link = svg
    .append("g")
    .attr("stroke", linkColor)
    .attr("stroke-width", 1)
    .selectAll("line")
    .data(links)
    .join("line");
  const node = svg
    .append("g")
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .attr("r", (d: any) => d.r)
    .attr("fill", (d) => C[d.type] ?? C.concept ?? "#8e8b82")
    .attr("stroke", nodeStroke)
    .attr("stroke-width", 1.5)
    .style("cursor", "pointer");
  const label = svg
    .append("g")
    .selectAll("text")
    .data(nodes)
    .join("text")
    .text((d) => d.label)
    .attr("font-size", 11)
    .attr("fill", labelFill)
    .attr("text-anchor", "middle")
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .attr("dy", (d: any) => -d.r - 4)
    .style("pointer-events", "none")
    .style("paint-order", "stroke")
    .style("stroke", nodeStroke)
    .style("stroke-width", "3px")
    .attr("opacity", (d) => ((deg[d.id] ?? 0) >= 3 ? 1 : 0));

  const adj: Record<string, Set<string>> = {};
  for (const n of nodes) adj[n.id] = new Set([n.id]);
  for (const l of data.links) {
    adj[l.source].add(l.target);
    adj[l.target].add(l.source);
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
    // doesn't explode past the panel; x/y gently center it (and cloud the edgeless
    // orphans around the core). The tick clamps to bounds so nothing clips.
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
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      for (const d of nodes as any) {
        d.x = Math.max(d.r + 4, Math.min(W - d.r - 4, d.x));
        d.y = Math.max(d.r + 4, Math.min(H - d.r - 4, d.y));
      }
      link
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
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      label.attr("x", (d: any) => d.x).attr("y", (d: any) => d.y);
    });

  node.call(
    d3
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      .drag<any, any>()
      .on("start", (e, d) => {
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
    .on("mouseover", (_e, d: any) => {
      const A = adj[d.id];
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      node.attr("opacity", (n: any) => (A.has(n.id) ? 1 : 0.12));
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      label.attr("opacity", (n: any) => (A.has(n.id) ? 1 : 0.05));
      link
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("opacity", (l: any) => (l.source.id === d.id || l.target.id === d.id ? 0.9 : 0.05))
        // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
        .attr("stroke", (l: any) =>
          l.source.id === d.id || l.target.id === d.id ? (C[d.type] ?? C.concept) : linkColor,
        );
    })
    .on("mouseout", () => {
      node.attr("opacity", 1);
      // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
      label.attr("opacity", (n: any) => ((deg[n.id] ?? 0) >= 3 ? 1 : 0));
      link.attr("opacity", 1).attr("stroke", linkColor);
    })
    // biome-ignore lint/suspicious/noExplicitAny: D3 typings require any
    .on("click", (_e, d: any) => opts.onOpen(d.id));

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
  });
  ro.observe(el);

  return {
    destroy() {
      ro.disconnect();
      sim.stop();
      svg.remove();
    },
  };
}
