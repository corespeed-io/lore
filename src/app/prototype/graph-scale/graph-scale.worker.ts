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

interface DragPointRequest {
  type: "drag-start" | "drag-move";
  id: string;
  x: number;
  y: number;
}

interface DragEndRequest {
  type: "drag-end";
  id: string;
}

type WorkerRequest = InitRequest | DragPointRequest | DragEndRequest;

let nodes: WorkerNode[] = [];
let nodeById = new Map<string, WorkerNode>();
let simulation: d3.Simulation<WorkerNode, WorkerLink> | null = null;
let draggedNode: WorkerNode | null = null;
let liveTick = 0;

function positionsSnapshot() {
  const positions = new Float32Array(nodes.length * 2);
  for (let index = 0; index < nodes.length; index += 1) {
    positions[index * 2] = nodes[index]?.x ?? 0;
    positions[index * 2 + 1] = nodes[index]?.y ?? 0;
  }
  return positions;
}

function postPositions(type: "done" | "frame", layoutMs?: number) {
  const positions = positionsSnapshot();
  self.postMessage(type === "done" ? { type, positions, layoutMs } : { type, positions }, {
    transfer: [positions.buffer],
  });
}

function initialize(request: InitRequest) {
  simulation?.stop();
  const startedAt = performance.now();
  nodes = request.nodes.map((node) => ({ ...node }));
  nodeById = new Map(nodes.map((node) => [node.id, node]));
  draggedNode = null;
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

  postPositions("done", performance.now() - startedAt);
  simulation
    .on("tick", () => {
      liveTick += 1;
      // Transferring every other simulation tick caps the Canvas stream near 30 fps.
      if (liveTick % 2 === 0) postPositions("frame");
    })
    .on("end", () => {
      postPositions("frame");
      self.postMessage({ type: "status", state: "settled" });
    });
}

function dragPoint(request: DragPointRequest) {
  const node = nodeById.get(request.id);
  if (!node || !simulation) return;
  if (request.type === "drag-start" && draggedNode && draggedNode !== node) {
    draggedNode.fx = null;
    draggedNode.fy = null;
  }
  draggedNode = node;
  node.fx = request.x;
  node.fy = request.y;
  simulation.alpha(Math.max(simulation.alpha(), 0.24)).alphaTarget(0.18).restart();
  if (request.type === "drag-start") {
    self.postMessage({ type: "status", state: "dragging" });
  }
}

function dragEnd(request: DragEndRequest) {
  const node = draggedNode ?? nodeById.get(request.id);
  if (!node || !simulation) return;
  node.fx = null;
  node.fy = null;
  draggedNode = null;
  simulation.alphaTarget(0);
  self.postMessage({ type: "status", state: "settling" });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") {
    initialize(event.data);
  } else if (event.data.type === "drag-end") {
    dragEnd(event.data);
  } else {
    dragPoint(event.data);
  }
};
