import { expect, test } from "vitest";
import { nodeType, parseWikilinks } from "../src/lib/graph.js";

test("parseWikilinks extracts slugs from [[slug]] and [[slug|label]]", () => {
  const t = "see [[people/hao-su|Hao]] and [[entities/haas]] and [[people/hao-su]]";
  expect(parseWikilinks(t)).toEqual(["people/hao-su", "entities/haas", "people/hao-su"]);
});

test("parseWikilinks returns [] when none", () => {
  expect(parseWikilinks("no links here")).toEqual([]);
});

test("nodeType infers from slug prefix, then falls back to given, then concept", () => {
  expect(nodeType("people/x")).toBe("person");
  expect(nodeType("companies/x")).toBe("company");
  expect(nodeType("entities/x")).toBe("product");
  expect(nodeType("gtm/x", "product")).toBe("product");
  expect(nodeType("gtm/x")).toBe("concept");
});
