import { expect, test, vi } from "vitest";
import { buildGraph, clearGraphCache, isHashTitle, nodeType } from "../src/lib/graph.js";

// Stub gbrain so buildGraph reads a fixed fixture instead of a live brain.
// `query` seeds the page set (titles/types); `get_links`/`get_backlinks` return
// the REAL edge rows the build now relies on (shape: {from_slug, to_slug}).
vi.mock("../src/lib/gbrain.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/gbrain.js")>();
  const SEEDS = [
    { slug: "companies/corespeed", title: "CoreSpeed", type: "company" },
    { slug: "people/hao-su", title: "Hao Su", type: "person" },
    // a seed with no edges either way → must be dropped as isolated
    { slug: "concepts/orphan", title: "Orphan", type: "concept" },
  ];
  const LINKS: Record<string, { from_slug: string; to_slug: string }[]> = {
    "companies/corespeed": [
      // a `mentions`/typed edge the old chunk-text scan would have missed
      { from_slug: "companies/corespeed", to_slug: "people/hao-su" },
      // a target that was never itself a seed → pendant node, slug-derived label
      { from_slug: "companies/corespeed", to_slug: "entities/haas" },
      // hash-titled target → dropped even though it's linked
      { from_slug: "companies/corespeed", to_slug: "concepts/7416e83d" },
    ],
    // reciprocal edge → must dedupe to a single undirected link
    "people/hao-su": [{ from_slug: "people/hao-su", to_slug: "companies/corespeed" }],
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
  // corespeed <-> hao-su (reciprocal → one edge) plus the pendant entities/haas
  expect(ids).toEqual(["companies/corespeed", "entities/haas", "people/hao-su"]);
  // reciprocal edge deduped; corespeed-haas kept → 2 undirected links
  expect(g.links).toHaveLength(2);
  // a non-seed link target still becomes a node, labeled + typed from its slug
  const haas = g.nodes.find((n) => n.id === "entities/haas");
  expect(haas).toMatchObject({ label: "haas", type: "product" });
  // hash-titled target dropped even though it was linked
  expect(ids).not.toContain("concepts/7416e83d");
  // seed with no edges dropped as isolated
  expect(ids).not.toContain("concepts/orphan");
});
