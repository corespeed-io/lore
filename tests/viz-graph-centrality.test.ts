import { describe, expect, test } from "vitest";
import { graphNodeCentrality } from "../src/lib/viz/graph-centrality";

describe("graph node centrality", () => {
  test("connection count increases gravity and visual radius", () => {
    const metrics = graphNodeCentrality(
      [{ id: "hub" }, { id: "middle" }, { id: "leaf-a" }, { id: "leaf-b" }, { id: "alone" }],
      [
        { source: "hub", target: "middle" },
        { source: "hub", target: "leaf-a" },
        { source: "hub", target: "leaf-b" },
        { source: "middle", target: "leaf-a" },
      ],
    );

    expect(metrics.get("hub")?.degree).toBe(3);
    expect(metrics.get("hub")?.gravity).toBeGreaterThan(metrics.get("middle")?.gravity ?? 0);
    expect(metrics.get("hub")?.radius).toBeGreaterThan(metrics.get("middle")?.radius ?? 0);
    expect(metrics.get("alone")?.radius).toBe(4);
  });

  test("only a bounded exceptional set becomes a hub", () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({ id: `node-${index}` }));
    const links = Array.from({ length: 40 }, (_, index) => ({
      source: "node-0",
      target: `node-${index + 1}`,
    }));
    const metrics = graphNodeCentrality(nodes, links);

    expect(metrics.get("node-0")?.hub).toBe(true);
    expect([...metrics.values()].filter((metric) => metric.hub)).toHaveLength(1);
  });

  test("uniform sparse graphs do not invent arbitrary hubs", () => {
    const metrics = graphNodeCentrality(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );

    expect([...metrics.values()].some((metric) => metric.hub)).toBe(false);
  });
});
