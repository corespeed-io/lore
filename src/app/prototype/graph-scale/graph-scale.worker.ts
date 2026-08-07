/// <reference lib="webworker" />

import * as d3 from "d3";

interface WorkerNode extends d3.SimulationNodeDatum {
  id: string;
  sourceIndex: number;
  anchorX: number;
  anchorY: number;
  collisionRadius: number;
  layoutStableTicks: number;
  layoutRevealed: boolean;
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
let particleLinkForce: d3.ForceLink<WorkerNode, WorkerLink> | null = null;
let graphLinks: LinkPair[] = [];
let adjacentIds = new Map<string, Set<string>>();
let incidentLinkIndices = new Map<string, number[]>();
let activeNodes: WorkerNode[] = [];
let activeIds = new Set<string>();
let activeLinkIndices = new Set<number>();
let activeLinkCount = 0;
let simulatedNodeCount = 0;
let simulatedLinkCount = 0;
let draggedNode: WorkerNode | null = null;
let physicsFrame = 0;
let physicsStartedAt = 0;
let physicsTimer: ReturnType<typeof setInterval> | null = null;
let maxCollisionRadius = 0;
let settledGrid = new Map<string, WorkerNode[]>();
let gridCellSize = 1;

// Every scale uses the same bounded interaction field so drag behavior remains
// consistent and never reheats unrelated particles across the full graph.
const MAX_ACTIVE_NODES = 900;
const MAX_BOUNDARY_NODES = 4_000;
const COMPACT_LINK_DISTANCE = 62;
const COMPACT_CHARGE_STRENGTH = -100;
const COMPACT_RADIAL_STRENGTH = 0.055;
// A coarse Barnes–Hut approximation keeps the local field inside a 60Hz budget.
const MANY_BODY_THETA = 1.4;
const LAYOUT_MAX_TICKS = 48;
const LAYOUT_MIN_TICKS = 36;
const LAYOUT_STABLE_SPEED_SQUARED = 0.04;
// At the fitted overview scale, two layout units are well below one screen
// pixel. Requiring two consecutive quiet ticks keeps the progressive reveal
// honest without waiting for the entire field to reach its terminal alpha.
const LAYOUT_REVEAL_SPEED_SQUARED = 4;
const LAYOUT_REVEAL_STABLE_TICKS = 2;
// A fixed interval avoids adding timer delay after every expensive force tick.
const TARGET_TICK_MS = 1_000 / 60;
// The old D3 timer sustained about 25 ticks/s at alpha 0.3. At 60Hz, 0.12
// preserves roughly the same post-release energy per wall-clock second.
const RELEASE_ALPHA = 0.12;
// Local interaction omits distant charge bodies. A weak spring to each particle's
// settled coordinate supplies the missing low-frequency field.
const PARTICLE_ANCHOR_STRENGTH = 0.012;

function postReady(layoutMs: number, layoutTicks: number) {
  self.postMessage({ type: "ready", layoutMs, layoutTicks });
}

function postLayoutProgress(tick: number, revealAll = false) {
  if (revealAll) {
    for (const node of nodes) node.layoutRevealed = true;
  }
  const revealed = nodes.filter((node) => node.layoutRevealed);
  const nodeIndices = new Uint32Array(revealed.length);
  const positions = new Float32Array(revealed.length * 2);
  for (let index = 0; index < revealed.length; index += 1) {
    const node = revealed[index];
    if (!node) continue;
    nodeIndices[index] = node.sourceIndex;
    positions[index * 2] = node.x ?? 0;
    positions[index * 2 + 1] = node.y ?? 0;
  }
  self.postMessage(
    {
      type: "progress",
      tick,
      totalTicks: LAYOUT_MAX_TICKS,
      revealedNodes: revealed.length,
      nodeIndices,
      positions,
    },
    { transfer: [nodeIndices.buffer, positions.buffer] },
  );
}

function postFrame(message: {
  frame: number;
  lockedId: string | null;
  activeNodes: number;
  activeLinks: number;
  physicsFps: number;
}) {
  const nodeIndices = new Uint32Array(activeNodes.length);
  const positions = new Float32Array(activeNodes.length * 2);
  for (let index = 0; index < activeNodes.length; index += 1) {
    const node = activeNodes[index];
    if (!node) continue;
    nodeIndices[index] = node.sourceIndex;
    positions[index * 2] = node.x ?? 0;
    positions[index * 2 + 1] = node.y ?? 0;
  }
  self.postMessage(
    {
      type: "frame",
      ...message,
      transferredNodes: activeNodes.length,
      simulatedNodes: simulatedNodeCount,
      simulatedLinks: simulatedLinkCount,
      nodeIndices,
      positions,
    },
    { transfer: [nodeIndices.buffer, positions.buffer] },
  );
}

function gridKey(column: number, row: number): string {
  return `${column}:${row}`;
}

function rebuildSettledGrid() {
  gridCellSize = Math.max(1, maxCollisionRadius * 4);
  const nextGrid = new Map<string, WorkerNode[]>();
  for (const node of nodes) {
    const column = Math.floor((node.anchorX ?? 0) / gridCellSize);
    const row = Math.floor((node.anchorY ?? 0) / gridCellSize);
    const key = gridKey(column, row);
    const cell = nextGrid.get(key) ?? [];
    cell.push(node);
    nextGrid.set(key, cell);
  }
  settledGrid = nextGrid;
}

function seedLayoutPositions(width: number, height: number) {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const spacing = maxCollisionRadius * 1.12;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const radius = spacing * Math.sqrt(index + 0.5);
    const angle = index * goldenAngle;
    node.x = width / 2 + Math.cos(angle) * radius;
    node.y = height / 2 + Math.sin(angle) * radius;
    node.vx = 0;
    node.vy = 0;
  }
}

function initialize(request: InitRequest) {
  stopPhysicsLoop();
  particleSimulation?.stop();
  layoutSimulation?.stop();
  const startedAt = performance.now();
  graphLinks = request.links.map((link) => ({ ...link }));
  const degrees = new Map<string, number>();
  for (const link of graphLinks) {
    degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
    degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
  }
  nodes = request.nodes.map((node, sourceIndex) => ({
    ...node,
    sourceIndex,
    anchorX: 0,
    anchorY: 0,
    collisionRadius: 4 + Math.min(12, (degrees.get(node.id) ?? 0) * 1.1) + request.collisionGap,
    layoutStableTicks: 0,
    layoutRevealed: false,
  }));
  maxCollisionRadius = Math.max(...nodes.map((node) => node.collisionRadius));
  nodeById = new Map(nodes.map((node) => [node.id, node]));
  activeNodes = [];
  activeIds = new Set();
  activeLinkIndices = new Set();
  activeLinkCount = 0;
  simulatedNodeCount = 0;
  simulatedLinkCount = 0;
  draggedNode = null;
  physicsFrame = 0;
  physicsStartedAt = 0;
  adjacentIds = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  incidentLinkIndices = new Map(nodes.map((node) => [node.id, []]));
  for (const [linkIndex, link] of graphLinks.entries()) {
    adjacentIds.get(link.source)?.add(link.target);
    adjacentIds.get(link.target)?.add(link.source);
    incidentLinkIndices.get(link.source)?.push(linkIndex);
    incidentLinkIndices.get(link.target)?.push(linkIndex);
  }
  seedLayoutPositions(request.width, request.height);
  const links: WorkerLink[] = graphLinks.map((link) => ({ ...link }));
  layoutSimulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink<WorkerNode, WorkerLink>(links)
        .id((node) => node.id)
        .distance(COMPACT_LINK_DISTANCE)
        .strength(0.25),
    )
    .force(
      "charge",
      d3.forceManyBody<WorkerNode>().strength(COMPACT_CHARGE_STRENGTH).theta(MANY_BODY_THETA),
    )
    .force("center", d3.forceCenter(request.width / 2, request.height / 2))
    .force("x", d3.forceX(request.width / 2).strength(0.015))
    .force("y", d3.forceY(request.height / 2).strength(0.015))
    .force(
      "radial",
      d3
        .forceRadial<WorkerNode>(0, request.width / 2, request.height / 2)
        .strength(COMPACT_RADIAL_STRENGTH),
    )
    .force(
      "collide",
      d3.forceCollide<WorkerNode>((node) => node.collisionRadius),
    )
    .alphaDecay(1 - 0.01 ** (1 / LAYOUT_MAX_TICKS))
    .stop();

  let layoutTicks = 0;
  let stableChecks = 0;
  postLayoutProgress(0);
  for (let tick = 0; tick < LAYOUT_MAX_TICKS; tick += 1) {
    layoutSimulation.tick();
    layoutTicks = tick + 1;
    for (const node of nodes) {
      const vx = node.vx ?? 0;
      const vy = node.vy ?? 0;
      if (vx * vx + vy * vy <= LAYOUT_REVEAL_SPEED_SQUARED) {
        node.layoutStableTicks += 1;
        if (node.layoutStableTicks >= LAYOUT_REVEAL_STABLE_TICKS) node.layoutRevealed = true;
      } else if (!node.layoutRevealed) {
        node.layoutStableTicks = 0;
      }
    }
    postLayoutProgress(layoutTicks);
    if (layoutTicks % 6 === 0) {
      if (layoutTicks >= LAYOUT_MIN_TICKS) {
        const meanSpeedSquared =
          nodes.reduce((total, node) => {
            const vx = node.vx ?? 0;
            const vy = node.vy ?? 0;
            return total + vx * vx + vy * vy;
          }, 0) / Math.max(1, nodes.length);
        stableChecks = meanSpeedSquared <= LAYOUT_STABLE_SPEED_SQUARED ? stableChecks + 1 : 0;
        if (stableChecks >= 2) break;
      }
    }
  }
  postLayoutProgress(layoutTicks, true);
  for (const node of nodes) {
    node.anchorX = node.x ?? 0;
    node.anchorY = node.y ?? 0;
    node.vx = 0;
    node.vy = 0;
    node.fx = node.x;
    node.fy = node.y;
  }
  rebuildSettledGrid();
  postReady(performance.now() - startedAt, layoutTicks);
}

function activateNode(node: WorkerNode) {
  if (activeIds.has(node.id) || activeNodes.length >= MAX_ACTIVE_NODES) return false;
  activeIds.add(node.id);
  activeNodes.push(node);
  node.vx = 0;
  node.vy = 0;
  node.fx = null;
  node.fy = null;
  for (const linkIndex of incidentLinkIndices.get(node.id) ?? []) {
    activeLinkIndices.add(linkIndex);
  }
  activeLinkCount = activeLinkIndices.size;
  return true;
}

function addNearbyNodes(x: number, y: number) {
  const fieldRadius = maxCollisionRadius * 12;
  const fieldRadiusSquared = fieldRadius * fieldRadius;
  const added: WorkerNode[] = [];
  const minimumColumn = Math.floor((x - fieldRadius) / gridCellSize);
  const maximumColumn = Math.floor((x + fieldRadius) / gridCellSize);
  const minimumRow = Math.floor((y - fieldRadius) / gridCellSize);
  const maximumRow = Math.floor((y + fieldRadius) / gridCellSize);
  for (let column = minimumColumn; column <= maximumColumn; column += 1) {
    for (let row = minimumRow; row <= maximumRow; row += 1) {
      for (const node of settledGrid.get(gridKey(column, row)) ?? []) {
        if (activeNodes.length >= MAX_ACTIVE_NODES) return added;
        if (activeIds.has(node.id)) continue;
        const dx = node.anchorX - x;
        const dy = node.anchorY - y;
        if (dx * dx + dy * dy > fieldRadiusSquared) continue;
        if (activateNode(node)) added.push(node);
      }
    }
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

function freezeActiveNodes() {
  for (const node of activeNodes) {
    node.anchorX = node.x ?? node.anchorX;
    node.anchorY = node.y ?? node.anchorY;
    node.fx = node.anchorX;
    node.fy = node.anchorY;
    node.vx = 0;
    node.vy = 0;
  }
}

function particleTopology(): { nodes: WorkerNode[]; links: WorkerLink[] } {
  const boundaryIds = new Set<string>();
  const links: WorkerLink[] = [];
  for (const linkIndex of activeLinkIndices) {
    const link = graphLinks[linkIndex];
    if (!link || !nodeById.has(link.source) || !nodeById.has(link.target)) continue;
    const missingBoundaryIds = [link.source, link.target].filter(
      (id) => !activeIds.has(id) && !boundaryIds.has(id),
    );
    if (boundaryIds.size + missingBoundaryIds.length > MAX_BOUNDARY_NODES) continue;
    for (const id of missingBoundaryIds) boundaryIds.add(id);
    links.push({ ...link });
  }
  const boundaryNodes = [...boundaryIds].flatMap((id) => {
    const node = nodeById.get(id);
    if (!node) return [];
    node.fx = node.anchorX;
    node.fy = node.anchorY;
    node.vx = 0;
    node.vy = 0;
    return [node];
  });
  const particleNodes = [...activeNodes, ...boundaryNodes];
  simulatedNodeCount = particleNodes.length;
  simulatedLinkCount = links.length;
  return { nodes: particleNodes, links };
}

function syncParticleTopology(simulation: d3.Simulation<WorkerNode, WorkerLink>) {
  const topology = particleTopology();
  // Clear mutated D3 link endpoints before replacing the simulation node map.
  particleLinkForce?.links([]);
  simulation.nodes(topology.nodes);
  particleLinkForce?.links(topology.links);
}

function postParticleFrame() {
  physicsFrame += 1;
  let movingNodes = 0;
  for (const node of activeNodes) {
    const vx = node.vx ?? 0;
    const vy = node.vy ?? 0;
    if (vx * vx + vy * vy > 0.0025) movingNodes += 1;
  }
  postFrame({
    frame: physicsFrame,
    lockedId: draggedNode?.id ?? null,
    activeNodes: movingNodes,
    activeLinks: activeLinkCount,
    physicsFps:
      physicsFrame > 1 ? ((physicsFrame - 1) * 1_000) / (performance.now() - physicsStartedAt) : 0,
  });
}

function stopPhysicsLoop() {
  if (physicsTimer !== null) clearInterval(physicsTimer);
  physicsTimer = null;
}

function finishParticleField(simulation: d3.Simulation<WorkerNode, WorkerLink>) {
  if (particleSimulation !== simulation) return;
  stopPhysicsLoop();
  freezeActiveNodes();
  rebuildSettledGrid();
  simulatedNodeCount = 0;
  simulatedLinkCount = 0;
  postFrame({
    frame: physicsFrame,
    lockedId: null,
    activeNodes: 0,
    activeLinks: 0,
    physicsFps:
      physicsFrame > 1 ? ((physicsFrame - 1) * 1_000) / (performance.now() - physicsStartedAt) : 0,
  });
  self.postMessage({ type: "status", state: "settled" });
}

function runPhysicsTick(simulation: d3.Simulation<WorkerNode, WorkerLink>) {
  if (particleSimulation !== simulation) return;
  simulation.tick();
  postParticleFrame();
  if (simulation.alphaTarget() === 0 && simulation.alpha() < simulation.alphaMin()) {
    finishParticleField(simulation);
  }
}

function startParticleField(node: WorkerNode, x: number, y: number) {
  stopPhysicsLoop();
  particleSimulation?.stop();
  particleSimulation = null;
  freezeActiveNodes();
  rebuildSettledGrid();
  activeNodes = [];
  activeIds = new Set();
  activeLinkIndices = new Set();
  activeLinkCount = 0;
  simulatedNodeCount = 0;
  simulatedLinkCount = 0;
  physicsFrame = 0;
  physicsStartedAt = performance.now();
  draggedNode = node;
  activateNode(node);
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

  const topology = particleTopology();
  particleLinkForce = d3
    .forceLink<WorkerNode, WorkerLink>(topology.links)
    .id((particle) => particle.id)
    .distance(COMPACT_LINK_DISTANCE)
    .strength(0.25);

  const simulation = d3
    .forceSimulation<WorkerNode, WorkerLink>(topology.nodes)
    .velocityDecay(0.4)
    .force("link", particleLinkForce)
    .force(
      "charge",
      d3.forceManyBody<WorkerNode>().strength(COMPACT_CHARGE_STRENGTH).theta(MANY_BODY_THETA),
    )
    .force(
      "collide",
      d3
        .forceCollide<WorkerNode>((particle) => particle.collisionRadius)
        .strength(1)
        .iterations(1),
    )
    .force(
      "x",
      d3.forceX<WorkerNode>((particle) => particle.anchorX).strength(PARTICLE_ANCHOR_STRENGTH),
    )
    .force(
      "y",
      d3.forceY<WorkerNode>((particle) => particle.anchorY).strength(PARTICLE_ANCHOR_STRENGTH),
    )
    .alpha(0.3)
    .alphaTarget(0.3)
    .stop();
  particleSimulation = simulation;
  physicsTimer = setInterval(() => runPhysicsTick(simulation), TARGET_TICK_MS);
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
  if (nearby.length > 0 || changed) syncParticleTopology(particleSimulation);
  node.x = request.x;
  node.y = request.y;
  node.fx = request.x;
  node.fy = request.y;
  particleSimulation.alpha(Math.max(particleSimulation.alpha(), 0.3)).alphaTarget(0.3);
}

function dragEnd(request: DragEndRequest) {
  const node = draggedNode ?? nodeById.get(request.id);
  if (!node || !particleSimulation) return;
  node.x = request.x;
  node.y = request.y;
  node.fx = null;
  node.fy = null;
  draggedNode = null;
  particleSimulation.alpha(Math.min(particleSimulation.alpha(), RELEASE_ALPHA)).alphaTarget(0);
  self.postMessage({ type: "status", state: "settling" });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") initialize(event.data);
  else if (event.data.type === "drag-end") dragEnd(event.data);
  else dragPoint(event.data);
};
