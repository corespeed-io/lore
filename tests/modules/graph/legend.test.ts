import { expect, test } from "vitest";
import {
  graphLegend,
  graphNodeConfiguredType,
  isGraphLegendFilter,
  matchesGraphLegendFilter,
} from "@/modules/graph/browser/legend";
import type { GraphNode } from "@/modules/graph/browser/types";

type LegendNode = Pick<GraphNode, "type" | "scope">;

test("an untyped Graph's palette already names scope, so the legend adds no scope entries", () => {
  const nodes: LegendNode[] = [
    { type: "shared", scope: "shared" },
    { type: "private", scope: "private" },
  ];
  const legend = graphLegend(nodes);

  expect(legend.types.map(({ type }) => type)).toEqual(["private", "shared"]);
  expect(legend.scopes).toEqual([]);
  expect(nodes.map(graphNodeConfiguredType)).toEqual([null, null]);
});

test("typed nodes take over the palette, so scope is stated as text with counts", () => {
  const nodes: LegendNode[] = [
    { type: "concept", scope: "shared" },
    { type: "concept", scope: "private" },
    { type: "person", scope: "shared" },
    { type: "shared", scope: "shared" },
  ];
  const legend = graphLegend(nodes);

  expect(legend.types.map(({ type }) => type)).toEqual(["concept", "person", "shared"]);
  expect(legend.scopes).toEqual([
    { scope: "shared", count: 3 },
    { scope: "private", count: 1 },
  ]);
  expect(graphNodeConfiguredType({ type: "concept", scope: "private" })).toBe("concept");
});

test("scope entries list only scopes present in the Graph", () => {
  expect(graphLegend([{ type: "concept", scope: "shared" }]).scopes).toEqual([
    { scope: "shared", count: 1 },
  ]);
});

test("legend filters select by type or by scope, never by the other", () => {
  const typedPrivate: LegendNode = { type: "concept", scope: "private" };

  expect(matchesGraphLegendFilter(typedPrivate, { kind: "type", value: "concept" })).toBe(true);
  expect(matchesGraphLegendFilter(typedPrivate, { kind: "scope", value: "private" })).toBe(true);
  expect(matchesGraphLegendFilter(typedPrivate, { kind: "type", value: "private" })).toBe(false);
  expect(matchesGraphLegendFilter(typedPrivate, { kind: "scope", value: "shared" })).toBe(false);

  expect(isGraphLegendFilter({ kind: "scope", value: "shared" }, "scope", "shared")).toBe(true);
  expect(isGraphLegendFilter({ kind: "scope", value: "shared" }, "type", "shared")).toBe(false);
  expect(isGraphLegendFilter(null, "type", "shared")).toBe(false);
});
