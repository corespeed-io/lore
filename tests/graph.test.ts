import { expect, test, vi } from "vitest";
import { callTool } from "../src/lib/gbrain.js";
import { buildGraph, clearGraphCache, isHashTitle, nodeType } from "../src/lib/graph.js";

// Stub gbrain so buildGraph reads a fixed fixture instead of a live brain.
// `query` seeds the page set (titles/types); `traverse_graph` (direction=both,
// depth 1) returns every edge incident to the slug — incoming + outgoing — in
// one call (shape: {from_slug, to_slug}), which is what the build now relies on.
vi.mock("../src/lib/gbrain.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/gbrain.js")>();
  const SEEDS = [
    { slug: "companies/acme", title: "Acme", type: "company" },
    { slug: "people/ada", title: "Ada Lovelace", type: "person" },
    // a seed with no edges either way → now remains as an isolated graph node
    { slug: "concepts/orphan", title: "Orphan", type: "concept" },
  ];
  const PAGES = [
    ...SEEDS,
    { slug: "extracts/receipt", title: "Receipt", type: "extract_receipt" },
    { slug: "tech/hash-import", title: "904b1d36", type: "concept" },
  ];
  // The full edge set; traverse_graph(both) returns the rows incident to a slug.
  const EDGES: { from_slug: string; to_slug: string }[] = [
    // a `mentions`/typed edge the old chunk-text scan would have missed
    { from_slug: "companies/acme", to_slug: "people/ada" },
    // a target that was never itself a seed → pendant node, slug-derived label
    { from_slug: "companies/acme", to_slug: "entities/widget" },
    // hash-titled target → dropped even though it's linked
    { from_slug: "companies/acme", to_slug: "concepts/7416e83d" },
    // reciprocal edge → must dedupe to a single undirected link
    { from_slug: "people/ada", to_slug: "companies/acme" },
  ];
  return {
    ...real,
    callTool: vi.fn(async (tool: string, args: { slug?: string }) => {
      if (tool === "list_pages") return { isError: false, text: JSON.stringify(PAGES) };
      if (tool === "query") return { isError: false, text: JSON.stringify(SEEDS) };
      if (tool === "traverse_graph") {
        const s = args.slug ?? "";
        const incident = EDGES.filter((e) => e.from_slug === s || e.to_slug === s);
        return { isError: false, text: JSON.stringify(incident) };
      }
      return { isError: false, text: "[]" };
    }),
  };
});

test("isHashTitle flags content-hash labels but not real titles", () => {
  expect(isHashTitle("7416e83d")).toBe(true);
  expect(isHashTitle("904b1d36")).toBe(true);
  expect(isHashTitle("CoreSpeed")).toBe(false);
  expect(isHashTitle("bytedance")).toBe(false);
  expect(isHashTitle("Haas Mcp Converged 0622")).toBe(false);
});

test("nodeType preserves backend type, then infers from slug prefix, then concept", () => {
  expect(nodeType("people/x", "founder")).toBe("founder");
  expect(nodeType("people/x")).toBe("person");
  expect(nodeType("companies/x")).toBe("company");
  expect(nodeType("entities/x")).toBe("product");
  expect(nodeType("gtm/x", "product")).toBe("product");
  expect(nodeType("extracts/x", "extract_receipt")).toBe("extract_receipt");
  expect(nodeType("gtm/x")).toBe("concept");
});

test("buildGraph builds from pages + the real link graph: isolated nodes stay in", async () => {
  clearGraphCache();
  const g = await buildGraph();
  const ids = g.nodes.map((n) => n.id).sort();
  // acme <-> ada (reciprocal → one edge), pendant entities/widget, plus isolated pages.
  expect(ids).toEqual([
    "companies/acme",
    "concepts/orphan",
    "entities/widget",
    "extracts/receipt",
    "people/ada",
  ]);
  // reciprocal edge deduped; acme-widget kept → 2 undirected links
  expect(g.links).toHaveLength(2);
  // a non-seed link target still becomes a node, labeled + typed from its slug
  const widget = g.nodes.find((n) => n.id === "entities/widget");
  expect(widget).toMatchObject({ label: "widget", type: "product" });
  // a legitimate no-edge page still becomes a graph node with its real backend type
  const receipt = g.nodes.find((n) => n.id === "extracts/receipt");
  expect(receipt).toMatchObject({ label: "Receipt", type: "extract_receipt" });
  // hash-titled target dropped even though it was linked
  expect(ids).not.toContain("concepts/7416e83d");
  // hash-titled page-list import also dropped
  expect(ids).not.toContain("tech/hash-import");
});

test("buildGraph fails loud instead of caching an edgeless graph when traversals error", async () => {
  clearGraphCache();
  const mocked = vi.mocked(callTool);
  const base = mocked.getMockImplementation();
  if (!base) throw new Error("callTool mock missing");
  // Pages/seeds still resolve (nodes exist), but every edge read fails → the
  // graph would be all-isolated. That must throw, not cache a scattered graph.
  mocked.mockImplementation(async (tool, args) => {
    if (tool === "traverse_graph") throw new Error("gbrain 429");
    return base(tool, args);
  });
  try {
    await expect(buildGraph()).rejects.toThrow(/traversals failed/);
  } finally {
    mocked.mockImplementation(base);
    clearGraphCache();
  }
});
