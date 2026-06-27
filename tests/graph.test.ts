import { expect, test, vi } from "vitest";
import { buildGraph, clearGraphCache, isHashTitle, nodeType } from "../src/lib/graph.js";

// Stub gbrain so buildGraph reads a fixed fixture instead of a live brain.
// `query` seeds the page set (titles/types); `get_links`/`get_backlinks` return
// the REAL edge rows the build now relies on (shape: {from_slug, to_slug}).
vi.mock("../src/lib/gbrain.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/gbrain.js")>();
  const SEEDS = [
    { slug: "companies/acme", title: "Acme", type: "company" },
    { slug: "people/ada", title: "Ada Lovelace", type: "person" },
    // a seed with no edges either way → must be dropped as isolated
    { slug: "concepts/orphan", title: "Orphan", type: "concept" },
  ];
  const LINKS: Record<string, { from_slug: string; to_slug: string }[]> = {
    "companies/acme": [
      // a `mentions`/typed edge the old chunk-text scan would have missed
      { from_slug: "companies/acme", to_slug: "people/ada" },
      // a target that was never itself a seed → pendant node, slug-derived label
      { from_slug: "companies/acme", to_slug: "entities/widget" },
      // hash-titled target → dropped even though it's linked
      { from_slug: "companies/acme", to_slug: "concepts/7416e83d" },
    ],
    // reciprocal edge → must dedupe to a single undirected link
    "people/ada": [{ from_slug: "people/ada", to_slug: "companies/acme" }],
  };
  return {
    ...real,
    callTool: vi.fn(async (tool: string, args: { slug?: string }) => {
      if (tool === "query") return { isError: false, text: JSON.stringify(SEEDS) };
      if (tool === "get_links")
        return { isError: false, text: JSON.stringify(LINKS[args.slug ?? ""] ?? []) };
      return { isError: false, text: "[]" }; // get_backlinks etc.
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

test("nodeType infers from slug prefix, then falls back to given, then concept", () => {
  expect(nodeType("people/x")).toBe("person");
  expect(nodeType("companies/x")).toBe("company");
  expect(nodeType("entities/x")).toBe("product");
  expect(nodeType("gtm/x", "product")).toBe("product");
  expect(nodeType("gtm/x")).toBe("concept");
});

test("buildGraph builds from the real link graph: pendant targets in, hash + isolated out", async () => {
  clearGraphCache();
  const g = await buildGraph();
  const ids = g.nodes.map((n) => n.id).sort();
  // acme <-> ada (reciprocal → one edge) plus the pendant entities/widget
  expect(ids).toEqual(["companies/acme", "entities/widget", "people/ada"]);
  // reciprocal edge deduped; acme-widget kept → 2 undirected links
  expect(g.links).toHaveLength(2);
  // a non-seed link target still becomes a node, labeled + typed from its slug
  const widget = g.nodes.find((n) => n.id === "entities/widget");
  expect(widget).toMatchObject({ label: "widget", type: "product" });
  // hash-titled target dropped even though it was linked
  expect(ids).not.toContain("concepts/7416e83d");
  // seed with no edges dropped as isolated
  expect(ids).not.toContain("concepts/orphan");
});
