import { expect, test } from "vitest";
import { degrees } from "../src/lib/viz/graph.js";

test("degrees counts undirected endpoints", () => {
  const d = degrees([
    { source: "a", target: "b" },
    { source: "a", target: "c" },
  ]);
  expect(d.a).toBe(2);
  expect(d.b).toBe(1);
  expect(d.c).toBe(1);
});
