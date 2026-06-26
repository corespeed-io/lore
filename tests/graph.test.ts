import { expect, test, vi } from "vitest";
import {
  buildGraph,
  clearGraphCache,
  isHashTitle,
  nodeType,
  parseWikilinks,
} from "../src/lib/graph.js";

// Stub gbrain so buildGraph crawls a fixed fixture instead of a live brain.
vi.mock("../src/lib/gbrain.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/gbrain.js")>();
  const PAGES = [
    {
      slug: "companies/corespeed",
      title: "CoreSpeed",
      type: "company",
      chunk_text: "[[people/hao-su]]",
    },
    {
      slug: "people/hao-su",
      title: "Hao Su",
      type: "person",
      chunk_text: "[[companies/corespeed]]",
    },
    // hash-titled — and it *does* link to corespeed, so only the hash filter can drop it
    {
      slug: "concepts/7416e83d",
      title: "7416e83d",
      type: "concept",
      chunk_text: "[[companies/corespeed]]",
    },
    // isolated — a real title but no wikilinks either way
    { slug: "concepts/orphan", title: "Orphan", type: "concept", chunk_text: "no links" },
  ];
  return {
    ...real,
    callTool: vi.fn(async () => ({ isError: false, text: JSON.stringify(PAGES) })),
  };
});

test("parseWikilinks extracts slugs from [[slug]] and [[slug|label]]", () => {
  const t = "see [[people/hao-su|Hao]] and [[entities/haas]] and [[people/hao-su]]";
  expect(parseWikilinks(t)).toEqual(["people/hao-su", "entities/haas", "people/hao-su"]);
});

test("parseWikilinks returns [] when none", () => {
  expect(parseWikilinks("no links here")).toEqual([]);
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

test("buildGraph keeps linked+titled nodes, drops hash-titled and isolated ones", async () => {
  clearGraphCache();
  const g = await buildGraph();
  const ids = g.nodes.map((n) => n.id).sort();
  // corespeed <-> hao-su are mutually linked + real titles → both survive, one edge
  expect(ids).toEqual(["companies/corespeed", "people/hao-su"]);
  expect(g.links).toHaveLength(1);
  // hash-titled node is dropped even though it linked to corespeed
  expect(ids).not.toContain("concepts/7416e83d");
  // isolated node (no wikilinks) is dropped
  expect(ids).not.toContain("concepts/orphan");
});
