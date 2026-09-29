import { afterEach, expect, test, vi } from "vitest";
import { readGraph } from "@/modules/graph/browser/data";
import { buildGraphStore, graphNeighbors } from "@/modules/graph/browser/store";
import type { GraphData, GraphNode } from "@/modules/graph/browser/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Graph read of `body`, as the browser makes it. */
async function readWith(body: object) {
  vi.stubGlobal("window", { location: { origin: "https://lore.test" } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
  return readGraph("10000000-0000-4000-8000-000000000001");
}

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
  const wire = {
    ...node("a", "ops/**clickhouse**", "## **ClickHouse** runbook"),
    preview: "Use `bun run ch:migrate` with [[ops/ch|ClickHouse]] and [docs](https://example.test)",
  };
  const links = [{ source: "a", target: "a", kind: "related", weight: 1, derived: false }];

  const graph = await readWith({ nodes: [wire], links, linksTruncated: true });

  expect(graph).toEqual({
    nodes: [{ ...wire, label: "ClickHouse runbook" }],
    links,
    linksTruncated: true,
  });
  // A reference is matched as written, so the read leaves it alone.
  expect(buildGraphStore(graph).byReference["ops/**clickhouse**"]).toBe("a");
});

test("a Graph label shows what the body shows, and as written when that is nothing", async () => {
  const nodes = [
    node("a", "a", "![](https://example.test/a.png)"),
    node("b", "b", "**"),
    node("c", "c", "**\u200B**"),
    node("d", "d", "[\u200B](https://x.test)"),
  ];

  const graph = await readWith({ nodes, links: [], linksTruncated: false });

  expect(graph.nodes.map((entry) => entry.label)).toEqual([
    "https://example.test/a.png",
    "**",
    "**\u200B**",
    "https://x.test\u200B",
  ]);
});

test("a Graph read parses only the labels the last reads did not bring", async () => {
  // Dense markup costs a parse per label, and each read brings up to 5,000 of them.
  const nodes = Array.from({ length: 5_000 }, (_, index) =>
    node(`n${index}`, `n${index}`, `## **Label** [${index}](https://x.test/${index}) _a_ \`b\``),
  );
  const firstStarted = performance.now();
  const first = await readWith({ nodes, links: [], linksTruncated: false });
  const firstTook = performance.now() - firstStarted;
  const againStarted = performance.now();
  const again = await readWith({ nodes, links: [], linksTruncated: false });
  const againTook = performance.now() - againStarted;

  expect(first.nodes[0]?.label).toBe("Label 0 a b");
  expect(again.nodes).toEqual(first.nodes);
  // Parsing every label again would take about as long as the first read did.
  expect(againTook).toBeLessThan(firstTook / 3);
});

test("a Graph node's type stays as written, the legend and filter key", async () => {
  const nodes = [{ ...node("a", "a"), type: "\u202Eeganam" }, node("b", "b")];

  const graph = await readWith({ nodes, links: [], linksTruncated: false });

  // Views show it through metadataLabel, which marks its hidden controls.
  expect(graph.nodes.map((entry) => entry.type)).toEqual(["\u202Eeganam", "concept"]);
});
