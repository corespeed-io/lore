import { expect, test } from "vitest";
import { buildGraphStore, graphNeighbors } from "@/modules/graph/browser/store";
import type { GraphData, GraphNode } from "@/modules/graph/browser/types";

function node(id: string, reference: string, label = id): GraphNode {
  return {
    id,
    reference,
    label,
    type: "concept",
    preview: "",
    scope: "shared",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
}

test("a wikilink reference resolves only to the one node that carries it", () => {
  const data: GraphData = {
    nodes: [node("a", "launch"), node("b", "shared-ref"), node("c", "shared-ref")],
    links: [],
  };
  const store = buildGraphStore(data);
  expect(store.byReference.launch).toBe("a");
  expect(store.byReference.a).toBe("a");
  // Two visible nodes share it, so neither is guessed.
  expect(store.byReference["shared-ref"]).toBeUndefined();
  expect(store.byReference.b).toBe("b");
  // Object prototype names are ordinary missing references.
  expect(store.byReference.toString).toBeUndefined();
});

test("neighbors come from links in both directions and never include the node itself", () => {
  const store = buildGraphStore({
    nodes: [node("a", "a", "Alpha"), node("b", "b", "Beta"), node("c", "c", "Gamma")],
    links: [
      { source: "a", target: "b", kind: "related", weight: 1 },
      { source: "c", target: "a", kind: "cites", weight: 0.5 },
    ],
  });
  expect(graphNeighbors(store, "a")).toEqual([
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ]);
  expect(graphNeighbors(store, "b")).toEqual([{ id: "a", label: "Alpha" }]);
  expect(graphNeighbors(store, "missing")).toEqual([]);
  expect(graphNeighbors(null, "a")).toEqual([]);
});

test("an ambiguous reference stays ambiguous however many nodes share it", () => {
  const store = buildGraphStore({
    nodes: [node("a", "dup"), node("b", "dup"), node("c", "dup"), node("d", "")],
    links: [],
  });
  // Without the ambiguity record, the third node would claim the reference again.
  expect(store.byReference.dup).toBeUndefined();
  // An empty reference is no reference; the node still answers to its id.
  expect(store.byReference[""]).toBeUndefined();
  expect(store.byReference.d).toBe("d");
});
