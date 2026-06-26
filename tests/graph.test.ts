import { expect, test } from "vitest";
import { isHashTitle, nodeType, parseWikilinks } from "../src/lib/graph.js";

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
