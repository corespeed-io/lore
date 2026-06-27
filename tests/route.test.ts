import { expect, test } from "vitest";
import { parseRoute, pathSegments, routeUrl, slugPath } from "../src/lib/route.js";

// Every expected value below is written by hand from the URL scheme, not derived
// by running the function under test.

test("parseRoute: default + ?tab= fallback", () => {
  expect(parseRoute("/", "").tab).toBe("overview");
  expect(parseRoute("/", "?tab=graph").tab).toBe("graph");
  expect(parseRoute("/", "?tab=search").tab).toBe("search");
  expect(parseRoute("/", "?tab=bogus").tab).toBe("overview"); // invalid → overview
});

test("admin console sections route by path; read surfaces unchanged", () => {
  for (const t of ["requests", "agents", "jobs", "calibration"] as const) {
    expect(parseRoute(`/${t}`, "").tab).toBe(t);
    expect(routeUrl({ tab: t })).toBe(`/${t}`);
  }
  // read surfaces still route as before — viewer flow intact
  expect(parseRoute("/memories", "").tab).toBe("search");
  expect(parseRoute("/graph", "").tab).toBe("graph");
  expect(routeUrl({ tab: "overview" })).toBe("/");
});

test("parseRoute: graph routes (focus vs page)", () => {
  expect(parseRoute("/graph", "")).toEqual({ tab: "graph", focus: undefined });
  expect(parseRoute("/graph/people/hao-su", "")).toEqual({
    tab: "graph",
    focus: "people/hao-su",
  });
  expect(parseRoute("/graph/page/people/hao-su", "?focus=companies/x")).toEqual({
    tab: "graph",
    page: "people/hao-su",
    focus: "companies/x",
  });
});

test("parseRoute: memories + page routes", () => {
  expect(parseRoute("/memories", "?q=hello&type=person")).toEqual({
    tab: "search",
    page: undefined,
    q: "hello",
    type: "person",
  });
  expect(parseRoute("/memories/some-slug", "")).toMatchObject({ tab: "search", page: "some-slug" });
  expect(parseRoute("/page/people/hao-su", "")).toEqual({
    tab: "overview",
    page: "people/hao-su",
  });
});

test("parseRoute: percent-decodes path segments", () => {
  // %20 → space, %2F → slash, both inside one segment
  expect(parseRoute("/page/a%2Fb%20c", "").page).toBe("a/b c");
});

test("routeUrl: paths per tab", () => {
  expect(routeUrl({ tab: "overview" })).toBe("/");
  expect(routeUrl({ tab: "overview", page: "people/hao-su" })).toBe("/page/people/hao-su");
  expect(routeUrl({ tab: "graph" })).toBe("/graph");
  expect(routeUrl({ tab: "graph", focus: "people/hao-su" })).toBe("/graph/people/hao-su");
  expect(routeUrl({ tab: "graph", page: "a/b" })).toBe("/graph/page/a/b");
  expect(routeUrl({ tab: "search" })).toBe("/memories");
  expect(routeUrl({ tab: "search", page: "x" })).toBe("/memories/x");
});

test("routeUrl: query params (q, type, focus) and 'all' omission", () => {
  expect(routeUrl({ tab: "search", q: "hi there" })).toBe("/memories?q=hi+there");
  expect(routeUrl({ tab: "search", type: "person" })).toBe("/memories?type=person");
  expect(routeUrl({ tab: "search", type: "all" })).toBe("/memories"); // "all" is the no-filter sentinel
  // focus is only serialized for a focused graph page
  expect(routeUrl({ tab: "graph", page: "a", focus: "b" })).toBe("/graph/page/a?focus=b");
  expect(routeUrl({ tab: "graph", focus: "b" })).toBe("/graph/b"); // focus becomes the path, no query
  // q/type are search-only — ignored on other tabs
  expect(routeUrl({ tab: "overview", q: "x", type: "person" })).toBe("/");
});

test("slugPath: encodes each segment, preserves the slash separator", () => {
  expect(slugPath("people/hao-su")).toBe("people/hao-su");
  expect(slugPath("a b/c#d")).toBe("a%20b/c%23d");
});

test("pathSegments: splits, drops empties, decodes", () => {
  expect(pathSegments("/a/b/")).toEqual(["a", "b"]);
  expect(pathSegments("")).toEqual([]);
  expect(pathSegments("/page/a%20b")).toEqual(["page", "a b"]);
});
