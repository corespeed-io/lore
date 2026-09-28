import { expect, test } from "vitest";
import {
  areGraphLinksPartial,
  GRAPH_NODE_LIMIT,
  type GraphData,
  isGraphCapped,
} from "@/modules/graph/browser/types";

function graphOf(nodeCount: number): GraphData {
  return {
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `node-${index}`,
      reference: `node-${index}`,
      label: `Node ${index}`,
      type: "note",
      preview: "",
      scope: "shared",
      updatedAt: "2026-09-24T00:00:00.000000Z",
    })),
    links: [],
  };
}

test("a Graph that fills the read budget is capped, and one node fewer is complete", () => {
  // The read asks for GRAPH_NODE_LIMIT nodes, so a full page may have omitted
  // visible Memories: its counts are lower bounds and absence proves nothing.
  expect(GRAPH_NODE_LIMIT).toBe(5_000);
  expect(isGraphCapped(graphOf(GRAPH_NODE_LIMIT))).toBe(true);
  expect(isGraphCapped(graphOf(GRAPH_NODE_LIMIT - 1))).toBe(false);
  expect(isGraphCapped(graphOf(0))).toBe(false);
});

test("cut Links make Link counts partial without claiming Memories were omitted", () => {
  const cut = { ...graphOf(1), linksTruncated: true };
  expect(isGraphCapped(cut)).toBe(false);
  expect(areGraphLinksPartial(cut)).toBe(true);
  expect(areGraphLinksPartial({ ...graphOf(1), linksTruncated: false })).toBe(false);
  // A full node budget makes Link counts partial too.
  expect(areGraphLinksPartial(graphOf(GRAPH_NODE_LIMIT))).toBe(true);
});
