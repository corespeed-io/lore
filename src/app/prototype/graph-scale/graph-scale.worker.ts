/// <reference lib="webworker" />

import * as d3 from "d3";

interface WorkerNode extends d3.SimulationNodeDatum {
  id: string;
}

interface WorkerLink extends d3.SimulationLinkDatum<WorkerNode> {
  source: string | WorkerNode;
  target: string | WorkerNode;
}

interface InitRequest {
  type: "init";
  nodes: { id: string }[];
  links: { source: string; target: string }[];
  width: number;
  height: number;
  collisionRadius: number;
}

interface SettleRequest {
  type: "settle";
  requestId: number;
  id: string;
  x: number;
  y: number;
}

type WorkerRequest = InitRequest | SettleRequest;

let nodes: WorkerNode[] = [];
let nodeById = new Map<string, WorkerNode>();
let simulation: d3.Simulation<WorkerNode, WorkerLink> | null = null;

function positionsSnapshot() {
  const positions = new Float32Array(nodes.length * 2);
  for (let index = 0; index < nodes.length; index += 1) {
    positions[index * 2] = nodes[index]?.x ?? 0;
    positions[index * 2 + 1] = nodes[index]?.y ?? 0;
  }
  return positions;
}

function postPositions(
  message:
    | { type: "ready"; layoutMs: number }
    | { type: "settled"; requestId: number; settleMs: number },
) {
  const positions = positionsSnapshot();
  self.postMessage({ ...message, positions }, { transfer: [positions.buffer] });
}

function initialize(request: InitRequest) {
  simulation?.stop();
  const startedAt = performance.now();
  nodes = request.nodes.map((node) => ({ ...node }));
  nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links: WorkerLink[] = request.links.map((link) => ({ ...link }));
  simulation = d3
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
    .force("center", d3.forceCenter(request.width / 2, request.height / 2))
    .force("x", d3.forceX(request.width / 2).strength(0.018))
    .force("y", d3.forceY(request.height / 2).strength(0.024))
    .force("collide", d3.forceCollide<WorkerNode>(request.collisionRadius))
    .stop();

  const totalTicks = 120;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    simulation.tick();
    if ((tick + 1) % 12 === 0) {
      self.postMessage({ type: "progress", progress: (tick + 1) / totalTicks });
    }
  }
  postPositions({ type: "ready", layoutMs: performance.now() - startedAt });
}

function settle(request: SettleRequest) {
  const node = nodeById.get(request.id);
  if (!node || !simulation) return;
  const startedAt = performance.now();
  simulation.stop().alpha(0.28).alphaTarget(0);

  // Hold the directly manipulated node briefly so collide/link forces push its
  // neighborhood out of the way, then release it and let the graph cool.
  node.x = request.x;
  node.y = request.y;
  node.fx = request.x;
  node.fy = request.y;
  simulation.tick(18);
  node.fx = null;
  node.fy = null;
  simulation.tick(42);

  postPositions({
    type: "settled",
    requestId: request.requestId,
    settleMs: performance.now() - startedAt,
  });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") initialize(event.data);
  else settle(event.data);
};
