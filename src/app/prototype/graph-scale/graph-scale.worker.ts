/// <reference lib="webworker" />

import * as d3 from "d3";

interface WorkerNode extends d3.SimulationNodeDatum {
  id: string;
  anchorX: number;
  anchorY: number;
  collisionRadius: number;
}

interface WorkerLink extends d3.SimulationLinkDatum<WorkerNode> {
  source: string | WorkerNode;
  target: string | WorkerNode;
}

interface LinkPair {
  source: string;
  target: string;
}

interface InitRequest {
  type: "init";
  nodes: { id: string }[];
  links: { source: string; target: string }[];
  width: number;
  height: number;
  collisionGap: number;
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
let particleSimulation: d3.Simulation<WorkerNode, WorkerLink> | null = null;
let graphLinks: LinkPair[] = [];
let particleLinks: WorkerLink[] = [];
let particleLinkForce: d3.ForceLink<WorkerNode, WorkerLink> | null = null;
let adjacentIds = new Map<string, Set<string>>();
let activeNodes: WorkerNode[] = [];
let activeIds = new Set<string>();
let draggedNode: WorkerNode | null = null;
let physicsFrame = 0;
let maxCollisionRadius = 0;

// The SVG control reheats all 5,000 nodes. This keeps its multi-hop propagation
// while bounding Worker interaction cost and preventing graph-wide tremble.
const MAX_ACTIVE_NODES = 900;

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
    | {
        type: "frame";
        frame: number;
        lockedId: string | null;
        activeNodes: number;
        activeLinks: number;
      },
) {
  const positions = positionsSnapshot();
  self.postMessage({ ...message, positions }, { transfer: [positions.buffer] });
}

function initialize(request: InitRequest) {
  particleSimulation?.stop();
  layoutSimulation?.stop();
  const startedAt = performance.now();
  graphLinks = request.links.map((link) => ({ ...link }));
  const degrees = new Map<string, number>();
  for (const link of graphLinks) {
    degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
    degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
  }
  nodes = request.nodes.map((node) => ({
    ...node,
    anchorX: 0,
    anchorY: 0,
    collisionRadius: 4 + Math.min(12, (degrees.get(node.id) ?? 0) * 1.1) + request.collisionGap,
  }));
  maxCollisionRadius = Math.max(...nodes.map((node) => node.collisionRadius));
  nodeById = new Map(nodes.map((node) => [node.id, node]));
  activeNodes = [];
  activeIds = new Set();
  particleLinks = [];
  particleLinkForce = null;
  draggedNode = null;
  physicsFrame = 0;
  adjacentIds = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const link of graphLinks) {
    adjacentIds.get(link.source)?.add(link.target);
    adjacentIds.get(link.target)?.add(link.source);
  }
  const links: WorkerLink[] = graphLinks.map((link) => ({ ...link }));
  layoutSimulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink<WorkerNode, WorkerLink>(links)
        .id((node) => node.id)
        .distance(78)
        .strength(0.25),
    )
    .force("charge", d3.forceManyBody<WorkerNode>().strength(-180))
    .force("center", d3.forceCenter(request.width / 2, request.height / 2))
    .force("x", d3.forceX(request.width / 2).strength(0.05))
    .force("y", d3.forceY(request.height / 2).strength(0.07))
    .force(
      "collide",
      d3.forceCollide<WorkerNode>((node) => node.collisionRadius),
    )
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

function rebuildParticleLinks() {
  particleLinks = [];
  for (const link of graphLinks) {
    if (!activeIds.has(link.source) || !activeIds.has(link.target)) continue;
    particleLinks.push({ ...link });
  }
  particleLinkForce?.links(particleLinks);
}

function activateNode(node: WorkerNode) {
  if (activeIds.has(node.id) || activeNodes.length >= MAX_ACTIVE_NODES) return false;
  activeIds.add(node.id);
  activeNodes.push(node);
  node.vx = 0;
  node.vy = 0;
  return true;
}

function addNearbyNodes(x: number, y: number) {
  const fieldRadius = maxCollisionRadius * 12;
  const fieldRadiusSquared = fieldRadius * fieldRadius;
  const added: WorkerNode[] = [];
  for (const node of nodes) {
    if (activeNodes.length >= MAX_ACTIVE_NODES) break;
    const dx = (node.x ?? 0) - x;
    const dy = (node.y ?? 0) - y;
    if (dx * dx + dy * dy > fieldRadiusSquared) continue;
    if (activateNode(node)) added.push(node);
  }
  return added;
}

function addLinkedNeighborhood(seedIds: string[], maxDepth: number) {
  const queue = seedIds.map((id) => ({ id, depth: 0 }));
  const visited = new Set(seedIds);
  let changed = false;
  for (
    let cursor = 0;
    cursor < queue.length && activeNodes.length < MAX_ACTIVE_NODES;
    cursor += 1
  ) {
    const current = queue[cursor];
    if (!current) continue;
    const node = nodeById.get(current.id);
    if (node && activateNode(node)) changed = true;
    if (current.depth >= maxDepth) continue;
    for (const neighborId of adjacentIds.get(current.id) ?? []) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      queue.push({ id: neighborId, depth: current.depth + 1 });
    }
  }
  return changed;
}

function syncParticleField(changed: boolean) {
  if (changed && particleSimulation) {
    particleSimulation.nodes(activeNodes);
    rebuildParticleLinks();
  }
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
    activeLinks: particleLinks.length,
  });
}

function startParticleField(node: WorkerNode, x: number, y: number) {
  particleSimulation?.stop();
  particleSimulation = null;
  particleLinkForce = null;
  if (draggedNode && draggedNode !== node) {
    draggedNode.fx = null;
    draggedNode.fy = null;
  }
  activeNodes = [];
  activeIds = new Set();
  physicsFrame = 0;
  draggedNode = node;
  const nearby = addNearbyNodes(x, y);
  addLinkedNeighborhood([node.id], 3);
  addLinkedNeighborhood(
    nearby.map((particle) => particle.id),
    1,
  );
  node.x = x;
  node.y = y;
  node.fx = x;
  node.fy = y;

  rebuildParticleLinks();
  particleLinkForce = d3
    .forceLink<WorkerNode, WorkerLink>(particleLinks)
    .id((particle) => particle.id)
    .distance(78)
    .strength(0.25);

  particleSimulation = d3
    .forceSimulation<WorkerNode, WorkerLink>(activeNodes)
    .velocityDecay(0.4)
    .force("link", particleLinkForce)
    .force("charge", d3.forceManyBody<WorkerNode>().strength(-180))
    .force(
      "collide",
      d3
        .forceCollide<WorkerNode>((particle) => particle.collisionRadius)
        .strength(1)
        .iterations(1),
    )
    // These per-node tethers stand in for links from the active subgraph to
    // inactive endpoints. Without them, local charge cuts the field loose and
    // peels it away from the settled graph.
    .force("x", d3.forceX<WorkerNode>((particle) => particle.anchorX).strength(0.035))
    .force("y", d3.forceY<WorkerNode>((particle) => particle.anchorY).strength(0.045))
    .alpha(0.3)
    .alphaTarget(0.3)
    .on("tick", postParticleFrame)
    .on("end", () => {
      postPositions({
        type: "frame",
        frame: physicsFrame,
        lockedId: null,
        activeNodes: 0,
        activeLinks: 0,
      });
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
  const nearby = addNearbyNodes(request.x, request.y);
  const changed = addLinkedNeighborhood(
    nearby.map((particle) => particle.id),
    1,
  );
  syncParticleField(nearby.length > 0 || changed);
  node.x = request.x;
  node.y = request.y;
  node.fx = request.x;
  node.fy = request.y;
  particleSimulation.alpha(Math.max(particleSimulation.alpha(), 0.3)).alphaTarget(0.3).restart();
}

function dragEnd(request: DragEndRequest) {
  const node = draggedNode ?? nodeById.get(request.id);
  if (!node || !particleSimulation) return;
  node.x = request.x;
  node.y = request.y;
  node.fx = null;
  node.fy = null;
  draggedNode = null;
  particleSimulation.alphaTarget(0).restart();
  self.postMessage({ type: "status", state: "settling" });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") initialize(event.data);
  else if (event.data.type === "drag-end") dragEnd(event.data);
  else dragPoint(event.data);
};
