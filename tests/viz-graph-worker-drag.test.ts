import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

interface DragRegressionMetrics {
  collisionOverlaps: {
    before: number;
    after: number;
  };
  draggedDistance: {
    maximum: number;
  };
  maximumNeighborStep: number;
  maximumReleaseTailStep: number;
  terminalReleaseStep: number;
  meanLinkedAnchorDrift: number;
  meanNeighborStep: number;
  neighborReversals: number;
  releaseAnchorDistance: {
    first: number;
    final: number;
  };
}

test("worker drag follows the pointer, stays calm, and springs after release", async () => {
  const fixture = new URL("./fixtures/graph-worker-drag-regression.ts", import.meta.url);
  const { stdout } = await execFileAsync("bun", [fixture.pathname], {
    timeout: 10_000,
  });
  const metrics = JSON.parse(stdout) as DragRegressionMetrics;

  expect(metrics.draggedDistance.maximum).toBeLessThan(0.01);
  expect(metrics.meanNeighborStep).toBeLessThan(0.08);
  expect(metrics.maximumNeighborStep).toBeLessThan(0.75);
  expect(metrics.neighborReversals).toBeLessThan(4);
  expect(metrics.collisionOverlaps.after).toBeLessThanOrEqual(metrics.collisionOverlaps.before);
  expect(metrics.meanLinkedAnchorDrift).toBeLessThan(35);
  expect(metrics.maximumReleaseTailStep).toBeLessThan(0.011);
  expect(metrics.terminalReleaseStep).toBeLessThan(0.011);

  expect(metrics.releaseAnchorDistance.final).toBeLessThan(
    metrics.releaseAnchorDistance.first * 0.92,
  );
  expect(metrics.releaseAnchorDistance.final).toBeGreaterThan(
    metrics.releaseAnchorDistance.first * 0.4,
  );
});
