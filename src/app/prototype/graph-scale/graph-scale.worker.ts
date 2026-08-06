/// <reference lib="webworker" />

import * as d3 from "d3";

interface WorkerNode extends d3.SimulationNodeDatum {
  id: string;
}

interface WorkerLink extends d3.SimulationLinkDatum<WorkerNode> {
  source: string | WorkerNode;
  target: string | WorkerNode;
}

interface LayoutRequest {
  nodes: { id: string }[];
  links: { source: string; target: string }[];
  width: number;
  height: number;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const startedAt = performance.now();
  const nodes: WorkerNode[] = event.data.nodes.map((node) => ({ ...node }));
  const links: WorkerLink[] = event.data.links.map((link) => ({ ...link }));
  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink<WorkerNode, WorkerLink>(links)
        .id((node) => node.id)
        .distance(28)
        .strength(0.08),
    )
    .force("charge", d3.forceManyBody<WorkerNode>().strength(-55).distanceMax(520).theta(1.1))
    .force("center", d3.forceCenter(event.data.width / 2, event.data.height / 2))
    .force("x", d3.forceX(event.data.width / 2).strength(0.018))
    .force("y", d3.forceY(event.data.height / 2).strength(0.024))
    .stop();

  const totalTicks = 120;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    simulation.tick();
    if ((tick + 1) % 12 === 0) {
      self.postMessage({ type: "progress", progress: (tick + 1) / totalTicks });
    }
  }

  const positions = new Float32Array(nodes.length * 2);
  for (let index = 0; index < nodes.length; index += 1) {
    positions[index * 2] = nodes[index]?.x ?? 0;
    positions[index * 2 + 1] = nodes[index]?.y ?? 0;
  }
  self.postMessage(
    { type: "done", positions, layoutMs: performance.now() - startedAt },
    { transfer: [positions.buffer] },
  );
};
