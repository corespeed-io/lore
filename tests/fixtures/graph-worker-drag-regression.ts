type WorkerMessage =
  | { type: "progress"; nodeIndices: Uint32Array; positions: Float32Array }
  | { type: "ready" }
  | { type: "status"; state: "dragging" | "settling" | "settled" }
  | { type: "frame"; nodeIndices: Uint32Array; positions: Float32Array };

const worker = new Worker(new URL("../../src/components/graph-canvas.worker.ts", import.meta.url), {
  type: "module",
});
const messages: WorkerMessage[] = [];
let latestLayout: Extract<WorkerMessage, { type: "progress" }> | null = null;
let resolveMessage: (() => void) | null = null;
worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === "progress") latestLayout = event.data;
  messages.push(event.data);
  resolveMessage?.();
  resolveMessage = null;
};

async function nextMessage(predicate: (message: WorkerMessage) => boolean) {
  while (true) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    await new Promise<void>((resolve) => {
      resolveMessage = resolve;
    });
  }
}

const neighborCount = 40;
const isolatedCount = 80;
const collisionGap = 12;
const fixtureNodes = [
  { id: "dragged", gravity: 1, hub: true, radius: 10 },
  ...Array.from({ length: neighborCount }, (_, index) => ({
    id: `neighbor-${index}`,
    gravity: 0.3,
    hub: false,
    radius: 6,
  })),
  ...Array.from({ length: isolatedCount }, (_, index) => ({
    id: `isolated-${index}`,
    gravity: 0.05,
    hub: false,
    radius: 6,
  })),
];
worker.postMessage({
  type: "init",
  nodes: fixtureNodes,
  links: [
    ...Array.from({ length: neighborCount }, (_, index) => ({
      source: "dragged",
      target: `neighbor-${index}`,
    })),
    ...Array.from({ length: neighborCount }, (_, index) => ({
      source: `neighbor-${index}`,
      target: `neighbor-${(index + 1) % neighborCount}`,
    })),
  ],
  width: 1_600,
  height: 1_000,
  collisionGap,
});

await nextMessage((message) => message.type === "ready");
const layout = latestLayout as unknown as Extract<WorkerMessage, { type: "progress" }>;
const draggedOffset = Array.from(layout.nodeIndices).indexOf(0) * 2;
const startX = layout.positions[draggedOffset] ?? 0;
const startY = layout.positions[draggedOffset + 1] ?? 0;
const pointerX = startX + 320;
const pointerY = startY + 80;
const layoutPositions = new Map<number, [number, number]>();
for (let index = 0; index < layout.nodeIndices.length; index += 1) {
  const nodeIndex = layout.nodeIndices[index];
  if (nodeIndex === undefined) continue;
  layoutPositions.set(nodeIndex, [
    layout.positions[index * 2] ?? 0,
    layout.positions[index * 2 + 1] ?? 0,
  ]);
}
const settledPositions = new Map(layoutPositions);

worker.postMessage({ type: "drag-start", id: "dragged", x: startX, y: startY });
await nextMessage((message) => message.type === "status" && message.state === "dragging");
worker.postMessage({ type: "drag-move", id: "dragged", x: pointerX, y: pointerY });
messages.length = 0;

const neighborFrames: Map<number, [number, number]>[] = [];
const draggedDistance: number[] = [];
while (neighborFrames.length < 120) {
  const message = await nextMessage((candidate) => candidate.type === "frame");
  if (message.type !== "frame") continue;
  const positions = new Map<number, [number, number]>();
  for (let index = 0; index < message.nodeIndices.length; index += 1) {
    const nodeIndex = message.nodeIndices[index];
    if (nodeIndex === undefined) continue;
    const position: [number, number] = [
      message.positions[index * 2] ?? 0,
      message.positions[index * 2 + 1] ?? 0,
    ];
    if (nodeIndex === 0) {
      draggedDistance.push(Math.hypot(position[0] - pointerX, position[1] - pointerY));
    } else {
      positions.set(nodeIndex, position);
    }
  }
  neighborFrames.push(positions);
}

const neighborSteps: number[] = [];
let neighborReversals = 0;
const previousVelocity = new Map<number, [number, number]>();
for (let frameIndex = 90; frameIndex < neighborFrames.length; frameIndex += 1) {
  const previous = neighborFrames[frameIndex - 1];
  const current = neighborFrames[frameIndex];
  if (!previous || !current) continue;
  for (const [nodeIndex, [x, y]] of current) {
    const before = previous.get(nodeIndex);
    if (!before) continue;
    const velocity: [number, number] = [x - before[0], y - before[1]];
    neighborSteps.push(Math.hypot(...velocity));
    const olderVelocity = previousVelocity.get(nodeIndex);
    if (olderVelocity && velocity[0] * olderVelocity[0] + velocity[1] * olderVelocity[1] < 0) {
      neighborReversals += 1;
    }
    previousVelocity.set(nodeIndex, velocity);
  }
}

messages.length = 0;
worker.postMessage({ type: "drag-end", id: "dragged", x: pointerX, y: pointerY });
const releaseAnchorDistance: number[] = [];
const releaseFrames: Map<number, [number, number]>[] = [];
while (true) {
  const message = await nextMessage(
    (candidate) => candidate.type === "frame" || candidate.type === "status",
  );
  if (message.type === "status" && message.state === "settled") break;
  if (message.type !== "frame") continue;
  for (let index = 0; index < message.nodeIndices.length; index += 1) {
    const nodeIndex = message.nodeIndices[index];
    if (nodeIndex === undefined) continue;
    const x = message.positions[index * 2] ?? 0;
    const y = message.positions[index * 2 + 1] ?? 0;
    settledPositions.set(nodeIndex, [x, y]);
    if (nodeIndex === 0) releaseAnchorDistance.push(Math.hypot(x - startX, y - startY));
  }
  releaseFrames.push(new Map(settledPositions));
}

worker.terminate();

function overlapCount(positions: Map<number, [number, number]>) {
  let overlaps = 0;
  for (let leftIndex = 0; leftIndex < fixtureNodes.length; leftIndex += 1) {
    const left = fixtureNodes[leftIndex];
    const leftPosition = positions.get(leftIndex);
    if (!left || !leftPosition) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < fixtureNodes.length; rightIndex += 1) {
      const right = fixtureNodes[rightIndex];
      const rightPosition = positions.get(rightIndex);
      if (!right || !rightPosition) continue;
      const distance = Math.hypot(
        leftPosition[0] - rightPosition[0],
        leftPosition[1] - rightPosition[1],
      );
      if (distance + 0.5 < left.radius + right.radius + collisionGap * 2) {
        overlaps += 1;
      }
    }
  }
  return overlaps;
}

function meanLinkedAnchorDrift() {
  let total = 0;
  for (let nodeIndex = 1; nodeIndex <= neighborCount; nodeIndex += 1) {
    const before = layoutPositions.get(nodeIndex);
    const after = settledPositions.get(nodeIndex);
    if (!before || !after) continue;
    total += Math.hypot(after[0] - before[0], after[1] - before[1]);
  }
  return total / neighborCount;
}

function maximumReleaseTailStep() {
  let maximum = 0;
  const firstFrame = Math.max(1, releaseFrames.length - 8);
  for (let frameIndex = firstFrame; frameIndex < releaseFrames.length; frameIndex += 1) {
    const before = releaseFrames[frameIndex - 1];
    const after = releaseFrames[frameIndex];
    if (!before || !after) continue;
    for (const [nodeIndex, [x, y]] of after) {
      const previous = before.get(nodeIndex);
      if (!previous) continue;
      maximum = Math.max(maximum, Math.hypot(x - previous[0], y - previous[1]));
    }
  }
  return maximum;
}

function terminalReleaseStep() {
  const before = releaseFrames.at(-3);
  const after = releaseFrames.at(-2);
  if (!before || !after) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (const [nodeIndex, [x, y]] of after) {
    const previous = before.get(nodeIndex);
    if (!previous) continue;
    maximum = Math.max(maximum, Math.hypot(x - previous[0], y - previous[1]));
  }
  return maximum;
}

console.log(
  JSON.stringify({
    draggedDistance: {
      maximum: Math.max(0, ...draggedDistance),
    },
    meanNeighborStep:
      neighborSteps.reduce((total, step) => total + step, 0) / Math.max(1, neighborSteps.length),
    maximumNeighborStep: Math.max(0, ...neighborSteps),
    neighborReversals,
    releaseAnchorDistance: {
      first: releaseAnchorDistance[0],
      final: releaseAnchorDistance.at(-1),
    },
    collisionOverlaps: {
      before: overlapCount(layoutPositions),
      after: overlapCount(settledPositions),
    },
    meanLinkedAnchorDrift: meanLinkedAnchorDrift(),
    maximumReleaseTailStep: maximumReleaseTailStep(),
    terminalReleaseStep: terminalReleaseStep(),
  }),
);
