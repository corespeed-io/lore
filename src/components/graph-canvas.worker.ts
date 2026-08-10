/// <reference lib="webworker" />

import * as d3 from "d3";
import { PARTICLE_FIELD_RADIUS_MULTIPLIER } from "@/lib/viz/graph-physics";

type WorkerNode = d3.SimulationNodeDatum & {
  id: string;
  gravity: number;
  hub: boolean;
  sourceIndex: number;
  anchorX: number;
  anchorY: number;
  wellX: number;
  wellY: number;
  collisionRadius: number;
  layoutStableTicks: number;
  layoutRevealed: boolean;
  lastFrameX: number;
  lastFrameY: number;
};

type WorkerLink = d3.SimulationLinkDatum<WorkerNode> & {
  source: string | WorkerNode;
  target: string | WorkerNode;
};

interface LinkPair {
  source: string;
  target: string;
}

interface InitRequest {
  type: "init";
  nodes: { id: string; gravity: number; hub: boolean; radius: number }[];
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
let particleXForce: d3.ForceX<WorkerNode> | null = null;
let particleYForce: d3.ForceY<WorkerNode> | null = null;
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
let lastDragInputAt = 0;
let settleStableFrames = 0;
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
const COLD_LINK_DISTANCE = 72;
const PARTICLE_LINK_DISTANCE = 62;
// Every Memory gets enough charge to open visible gaps between local clusters,
// while high-degree nodes make more room for their denser neighbourhoods.
const COMPACT_CHARGE_BASE = -20;
const COMPACT_CHARGE_RANGE = -45;
const PARTICLE_CHARGE_STRENGTH = -12;
const GRAVITY_WELL_WIDTH_RATIO = 0.75;
const GRAVITY_WELL_HEIGHT_RATIO = 0.6;
const GRAVITY_WELL_STRENGTH = 0.09;
const HUB_GRAVITY_WELL_STRENGTH = 0.26;
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
// Release reheats the field just enough to make the anchor spring visibly pull
// back before alpha decay freezes the new, partially displaced shape.
const RELEASE_ALPHA = 0.12;
// During a drag, a light anchor lets the relation spring move neighbours. On
// release, the dragged Memory keeps a gentle pull while its neighbours return
// firmly to their own anchors instead of collapsing around the new drop point.
const PARTICLE_DRAG_ANCHOR_STRENGTH = 0.025;
const PARTICLE_SETTLE_DRAGGED_ANCHOR_STRENGTH = 0.45;
const PARTICLE_SETTLE_NEIGHBOR_ANCHOR_STRENGTH = 4.5;
const PARTICLE_RELEASE_DRAGGED_LINK_STRENGTH = 0.025;
const PARTICLE_RELEASE_LINK_STRENGTH = 0.16;
const PARTICLE_DRAG_VELOCITY_DECAY = 0.8;
const PARTICLE_DRAG_ALPHA = 0.24;
const PARTICLE_ALPHA_DECAY = 0.08;
const PARTICLE_DRAG_IDLE_MS = 90;
const PARTICLE_SETTLE_DELTA_SQUARED = 0.0001;
const PARTICLE_SETTLE_STABLE_FRAMES = 4;

function linkEndpointId(endpoint: string | WorkerNode) {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

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

function assignGravityWells(width: number, height: number) {
  const hubs = nodes
    .filter((node) => node.hub)
    .sort((left, right) => right.gravity - left.gravity || left.id.localeCompare(right.id));
  if (hubs.length === 0) {
    for (const node of nodes) {
      node.wellX = width / 2;
      node.wellY = height / 2;
    }
    return;
  }

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const ownerById = new Map<string, WorkerNode>();
  const queue: WorkerNode[] = [];
  for (const [index, hub] of hubs.entries()) {
    const radius = index === 0 ? 0 : Math.sqrt(index / Math.max(1, hubs.length - 1));
    const angle = index * goldenAngle - Math.PI / 2;
    hub.wellX = width / 2 + Math.cos(angle) * width * GRAVITY_WELL_WIDTH_RATIO * radius;
    hub.wellY = height / 2 + Math.sin(angle) * height * GRAVITY_WELL_HEIGHT_RATIO * radius;
    ownerById.set(hub.id, hub);
    queue.push(hub);
  }

  // A deterministic multi-source walk assigns each connected Memory to its
  // nearest visible hub. The result is several topology-shaped gravity wells,
  // not one radial force that packs the complete graph into a ball.
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current) continue;
    const owner = ownerById.get(current.id);
    if (!owner) continue;
    for (const neighborId of adjacentIds.get(current.id) ?? []) {
      if (ownerById.has(neighborId)) continue;
      const neighbor = nodeById.get(neighborId);
      if (!neighbor) continue;
      ownerById.set(neighborId, owner);
      queue.push(neighbor);
    }
  }

  for (const node of nodes) {
    const owner = ownerById.get(node.id);
    node.wellX = owner?.wellX ?? node.x ?? width / 2;
    node.wellY = owner?.wellY ?? node.y ?? height / 2;
  }
}

function initialize(request: InitRequest) {
  stopPhysicsLoop();
  particleSimulation?.stop();
  layoutSimulation?.stop();
  const startedAt = performance.now();
  graphLinks = request.links.map((link) => ({ ...link }));
  nodes = request.nodes.map((node, sourceIndex) => ({
    ...node,
    sourceIndex,
    anchorX: 0,
    anchorY: 0,
    wellX: 0,
    wellY: 0,
    collisionRadius: node.radius + request.collisionGap,
    layoutStableTicks: 0,
    layoutRevealed: false,
    lastFrameX: 0,
    lastFrameY: 0,
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
  assignGravityWells(request.width, request.height);
  const links: WorkerLink[] = graphLinks.map((link) => ({ ...link }));
  layoutSimulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink<WorkerNode, WorkerLink>(links)
        .id((node) => node.id)
        .distance(COLD_LINK_DISTANCE)
        .strength(0.08),
    )
    .force(
      "charge",
      d3
        .forceManyBody<WorkerNode>()
        .strength((node) => COMPACT_CHARGE_BASE + node.gravity * COMPACT_CHARGE_RANGE)
        .theta(MANY_BODY_THETA),
    )
    .force("center", d3.forceCenter(request.width / 2, request.height / 2))
    .force(
      "x",
      d3
        .forceX<WorkerNode>((node) => node.wellX)
        .strength((node) => (node.hub ? HUB_GRAVITY_WELL_STRENGTH : GRAVITY_WELL_STRENGTH)),
    )
    .force(
      "y",
      d3
        .forceY<WorkerNode>((node) => node.wellY)
        .strength((node) => (node.hub ? HUB_GRAVITY_WELL_STRENGTH : GRAVITY_WELL_STRENGTH)),
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
  node.lastFrameX = node.x ?? node.anchorX;
  node.lastFrameY = node.y ?? node.anchorY;
  node.fx = null;
  node.fy = null;
  for (const linkIndex of incidentLinkIndices.get(node.id) ?? []) {
    activeLinkIndices.add(linkIndex);
  }
  activeLinkCount = activeLinkIndices.size;
  return true;
}

function addNearbyNodes(x: number, y: number) {
  const fieldRadius = maxCollisionRadius * PARTICLE_FIELD_RADIUS_MULTIPLIER;
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

function addCollisionBoundaryNodes(boundaryIds: Set<string>) {
  const boundaryPadding = 6;
  for (const activeNode of activeNodes) {
    const searchRadius = activeNode.collisionRadius + maxCollisionRadius + boundaryPadding;
    const searchRadiusSquared = searchRadius * searchRadius;
    const positions = [
      [activeNode.anchorX, activeNode.anchorY],
      [activeNode.x ?? activeNode.anchorX, activeNode.y ?? activeNode.anchorY],
    ];
    for (const [x, y] of positions) {
      if (x === undefined || y === undefined) continue;
      const minimumColumn = Math.floor((x - searchRadius) / gridCellSize);
      const maximumColumn = Math.floor((x + searchRadius) / gridCellSize);
      const minimumRow = Math.floor((y - searchRadius) / gridCellSize);
      const maximumRow = Math.floor((y + searchRadius) / gridCellSize);
      for (let column = minimumColumn; column <= maximumColumn; column += 1) {
        for (let row = minimumRow; row <= maximumRow; row += 1) {
          for (const candidate of settledGrid.get(gridKey(column, row)) ?? []) {
            if (
              activeIds.has(candidate.id) ||
              boundaryIds.has(candidate.id) ||
              boundaryIds.size >= MAX_BOUNDARY_NODES
            ) {
              continue;
            }
            const dx = candidate.anchorX - x;
            const dy = candidate.anchorY - y;
            if (dx * dx + dy * dy <= searchRadiusSquared) boundaryIds.add(candidate.id);
          }
        }
      }
    }
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
  // Linked particles can return through parts of the settled field that were
  // never activated by the pointer path. Include nearby static Memories as
  // fixed collision bodies so release cannot pack active nodes on top of them.
  addCollisionBoundaryNodes(boundaryIds);
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
  let maximumDeltaSquared = 0;
  for (const node of activeNodes) {
    const x = node.x ?? node.anchorX;
    const y = node.y ?? node.anchorY;
    const dx = x - node.lastFrameX;
    const dy = y - node.lastFrameY;
    const deltaSquared = dx * dx + dy * dy;
    node.lastFrameX = x;
    node.lastFrameY = y;
    maximumDeltaSquared = Math.max(maximumDeltaSquared, deltaSquared);
    if (deltaSquared > 0.0025) movingNodes += 1;
  }
  postFrame({
    frame: physicsFrame,
    lockedId: draggedNode?.id ?? null,
    activeNodes: movingNodes,
    activeLinks: activeLinkCount,
    physicsFps:
      physicsFrame > 1 ? ((physicsFrame - 1) * 1_000) / (performance.now() - physicsStartedAt) : 0,
  });
  return maximumDeltaSquared;
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
  if (draggedNode && performance.now() - lastDragInputAt >= PARTICLE_DRAG_IDLE_MS) {
    simulation.alphaTarget(0);
  }
  simulation.tick();
  const maximumDeltaSquared = postParticleFrame();
  if (
    !draggedNode &&
    simulation.alphaTarget() === 0 &&
    simulation.alpha() < simulation.alphaMin()
  ) {
    settleStableFrames =
      maximumDeltaSquared <= PARTICLE_SETTLE_DELTA_SQUARED ? settleStableFrames + 1 : 0;
    if (settleStableFrames >= PARTICLE_SETTLE_STABLE_FRAMES) finishParticleField(simulation);
  } else {
    settleStableFrames = 0;
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
  settleStableFrames = 0;
  physicsStartedAt = performance.now();
  draggedNode = node;
  lastDragInputAt = performance.now();
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
    .distance(PARTICLE_LINK_DISTANCE)
    .strength(0.25);
  particleXForce = d3
    .forceX<WorkerNode>((particle) => particle.anchorX)
    .strength(PARTICLE_DRAG_ANCHOR_STRENGTH);
  particleYForce = d3
    .forceY<WorkerNode>((particle) => particle.anchorY)
    .strength(PARTICLE_DRAG_ANCHOR_STRENGTH);

  const simulation = d3
    .forceSimulation<WorkerNode, WorkerLink>(topology.nodes)
    .velocityDecay(PARTICLE_DRAG_VELOCITY_DECAY)
    .alphaDecay(PARTICLE_ALPHA_DECAY)
    .force("link", particleLinkForce)
    .force(
      "charge",
      d3.forceManyBody<WorkerNode>().strength(PARTICLE_CHARGE_STRENGTH).theta(MANY_BODY_THETA),
    )
    .force(
      "collide",
      d3
        .forceCollide<WorkerNode>((particle) => particle.collisionRadius)
        .strength(1)
        .iterations(1),
    )
    .force("x", particleXForce)
    .force("y", particleYForce)
    .alpha(PARTICLE_DRAG_ALPHA)
    .alphaTarget(PARTICLE_DRAG_ALPHA)
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
  lastDragInputAt = performance.now();
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
  particleSimulation
    .alpha(Math.max(particleSimulation.alpha(), PARTICLE_DRAG_ALPHA))
    .alphaTarget(PARTICLE_DRAG_ALPHA);
}

function dragEnd(request: DragEndRequest) {
  const node = draggedNode ?? nodeById.get(request.id);
  if (!node || !particleSimulation) return;
  node.fx = null;
  node.fy = null;
  draggedNode = null;
  settleStableFrames = 0;
  particleXForce?.strength((particle) =>
    particle === node
      ? PARTICLE_SETTLE_DRAGGED_ANCHOR_STRENGTH
      : PARTICLE_SETTLE_NEIGHBOR_ANCHOR_STRENGTH,
  );
  particleYForce?.strength((particle) =>
    particle === node
      ? PARTICLE_SETTLE_DRAGGED_ANCHOR_STRENGTH
      : PARTICLE_SETTLE_NEIGHBOR_ANCHOR_STRENGTH,
  );
  particleLinkForce?.strength((link) =>
    linkEndpointId(link.source) === node.id || linkEndpointId(link.target) === node.id
      ? PARTICLE_RELEASE_DRAGGED_LINK_STRENGTH
      : PARTICLE_RELEASE_LINK_STRENGTH,
  );
  syncParticleTopology(particleSimulation);
  particleSimulation.alpha(Math.max(particleSimulation.alpha(), RELEASE_ALPHA)).alphaTarget(0);
  self.postMessage({ type: "status", state: "settling" });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "init") initialize(event.data);
  else if (event.data.type === "drag-end") dragEnd(event.data);
  else dragPoint(event.data);
};
