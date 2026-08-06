/// <reference lib="webworker" />

import * as d3 from "d3";

interface WorkerNode extends d3.SimulationNodeDatum {
  id: string;
  anchorX: number;
  anchorY: number;
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
  x: number;
  y: number;
}

type WorkerRequest = InitRequest | DragPointRequest | DragEndRequest;

let nodes: WorkerNode[] = [];
let nodeById = new Map<string, WorkerNode>();
let layoutSimulation: d3.Simulation<WorkerNode, WorkerLink> | null = null;
let particleSimulation: d3.Simulation<WorkerNode, undefined> | null = null;
let activeNodes: WorkerNode[] = [];
let activeIds = new Set<string>();
let draggedNode: WorkerNode | null = null;
let physicsFrame = 0;
let collisionRadius = 0;

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
    | { type: "frame"; frame: number; lockedId: string | null; activeNodes: number },
) {
  const positions = positionsSnapshot();
  self.postMessage({ ...message, positions }, { transfer: [positions.buffer] });
}

function initialize(request: InitRequest) {
  particleSimulation?.stop();
  layoutSimulation?.stop();
  const startedAt = performance.now();
  collisionRadius = request.collisionRadius;
  nodes = request.nodes.map((node) => ({ ...node, anchorX: 0, anchorY: 0 }));
  nodeById = new Map(nodes.map((node) => [node.id, node]));
  activeNodes = [];
  activeIds = new Set();
  draggedNode = null;
  physicsFrame = 0;
  const links: WorkerLink[] = request.links.map((link) => ({ ...link }));
  layoutSimulation = d3
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
    layoutSimulation.tick();
    if ((tick + 1) % 12 === 0) {
      self.postMessage({ type: "progress", progress: (tick + 1) / totalTicks });
    }
  }
  for (const node of nodes) {
    node.anchorX = node.x ?? 0;
    node.anchorY = node.y ?? 0;
    node.vx = 0;
    node.vy = 0;
  }
  postPositions({ type: "ready", layoutMs: performance.now() - startedAt });
}

function addNearbyNodes(x: number, y: number) {
  const fieldRadius = collisionRadius * 12;
  const fieldRadiusSquared = fieldRadius * fieldRadius;
  let changed = false;
  for (const node of nodes) {
    if (activeIds.has(node.id)) continue;
    const dx = (node.x ?? 0) - x;
    const dy = (node.y ?? 0) - y;
    if (dx * dx + dy * dy > fieldRadiusSquared) continue;
    activeIds.add(node.id);
    activeNodes.push(node);
    node.vx = 0;
    node.vy = 0;
    changed = true;
  }
  if (changed && particleSimulation) particleSimulation.nodes(activeNodes);
}

function postParticleFrame() {
  physicsFrame += 1;
  let movingNodes = 0;
  for (const node of activeNodes) {
    const vx = node.vx ?? 0;
    const vy = node.vy ?? 0;
    if (vx * vx + vy * vy > 0.0025) movingNodes += 1;
  }
  postPositions({
    type: "frame",
    frame: physicsFrame,
    lockedId: draggedNode?.id ?? null,
    activeNodes: movingNodes,
  });
}

function startParticleField(node: WorkerNode, x: number, y: number) {
  particleSimulation?.stop();
  if (draggedNode && draggedNode !== node) {
    draggedNode.fx = null;
    draggedNode.fy = null;
  }
  activeNodes = [];
  activeIds = new Set();
  physicsFrame = 0;
  draggedNode = node;
  addNearbyNodes(x, y);
  if (!activeIds.has(node.id)) {
    activeIds.add(node.id);
    activeNodes.push(node);
  }
  node.x = x;
  node.y = y;
  node.fx = x;
  node.fy = y;

  particleSimulation = d3
    .forceSimulation<WorkerNode>(activeNodes)
    .velocityDecay(0.28)
    .alphaDecay(0.055)
    .force("collide", d3.forceCollide<WorkerNode>(collisionRadius).strength(1).iterations(1))
    .force("x", d3.forceX<WorkerNode>((particle) => particle.anchorX).strength(0.012))
    .force("y", d3.forceY<WorkerNode>((particle) => particle.anchorY).strength(0.012))
    .alpha(0.32)
    .alphaTarget(0.14)
    .on("tick", postParticleFrame)
    .on("end", () => {
      postPositions({ type: "frame", frame: physicsFrame, lockedId: null, activeNodes: 0 });
      self.postMessage({ type: "status", state: "settled" });
    });
  self.postMessage({ type: "status", state: "dragging" });
}

function dragPoint(request: DragPointRequest) {
  const node = nodeById.get(request.id);
  if (!node) return;
  if (request.type === "drag-start" || !particleSimulation || draggedNode !== node) {
    startParticleField(node, request.x, request.y);
    return;
  }
  addNearbyNodes(request.x, request.y);
  node.x = request.x;
  node.y = request.y;
  node.fx = request.x;
  node.fy = request.y;
  particleSimulation
    .alphaDecay(0.055)
    .alpha(Math.max(particleSimulation.alpha(), 0.24))
    .alphaTarget(0.14)
    .restart();
}

function dragEnd(request: DragEndRequest) {
  const node = draggedNode ?? nodeById.get(request.id);
  if (!node || !particleSimulation) return;
  node.x = request.x;
  node.y = request.y;
  node.fx = null;
  node.fy = null;
  draggedNode = null;
  particleSimulation.alphaTarget(0).alphaDecay(0.1).restart();
  self.postMessage({ type: "status", state: "settling" });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") initialize(event.data);
  else if (event.data.type === "drag-end") dragEnd(event.data);
  else dragPoint(event.data);
};
