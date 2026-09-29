import { afterEach, expect, test, vi } from "vitest";
import { readGraph } from "@/modules/graph/browser/data";
import { buildGraphStore, graphNeighbors } from "@/modules/graph/browser/store";
import type { GraphData, GraphNode } from "@/modules/graph/browser/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

test("a Graph read shows label text without markup, and references still resolve", async () => {
  vi.stubGlobal("window", { location: { origin: "https://lore.test" } });
  const wire = {
    ...node("a", "ops/**clickhouse**", "## **ClickHouse** runbook"),
    preview: "Use `bun run ch:migrate` with [[ops/ch|ClickHouse]] and [docs](https://example.test)",
  };
  const links = [{ source: "a", target: "a", kind: "related", weight: 1, derived: false }];
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ nodes: [wire], links, linksTruncated: true }));
  vi.stubGlobal("fetch", fetcher);

  const graph = await readGraph("10000000-0000-4000-8000-000000000001");

  expect(graph).toEqual({
    nodes: [
      {
        ...wire,
        label: "ClickHouse runbook",
      },
    ],
    links,
    linksTruncated: true,
  });
  // A reference is matched as written, so the read leaves it alone.
  expect(buildGraphStore(graph).byReference["ops/**clickhouse**"]).toBe("a");
});

test("a Graph label that is only markup keeps its text rather than going blank", async () => {
  vi.stubGlobal("window", { location: { origin: "https://lore.test" } });
  const nodes = [
    node("a", "a", "![](https://example.test/a.png)"),
    node("b", "b", "**"),
    node("c", "c", "![](https://example.test/\u202E)"),
  ];
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ nodes, links: [], linksTruncated: false }));
  vi.stubGlobal("fetch", fetcher);

  const graph = await readGraph("10000000-0000-4000-8000-000000000001");

  expect(graph.nodes.map((entry) => entry.label)).toEqual([
    "![](https://example.test/a.png)",
    "**",
    // Kept as written, its hidden controls still show.
    "![](https://example.test/⟨U+202E⟩)",
  ]);
});

test("a Graph node's type shows its hidden controls as markers", async () => {
  vi.stubGlobal("window", { location: { origin: "https://lore.test" } });
  const nodes = [{ ...node("a", "a"), type: "\u202Eeganam" }, node("b", "b")];
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ nodes, links: [], linksTruncated: false }));
  vi.stubGlobal("fetch", fetcher);

  const graph = await readGraph("10000000-0000-4000-8000-000000000001");

  expect(graph.nodes.map((entry) => entry.type)).toEqual(["⟨U+202E⟩eganam", "concept"]);
});
