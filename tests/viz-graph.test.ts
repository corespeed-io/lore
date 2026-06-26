import { expect, test } from "vitest";
import { degrees, graphLabelText, labelBoxesOverlap } from "../src/lib/viz/graph.js";

test("degrees counts undirected endpoints", () => {
  const d = degrees([
    { source: "a", target: "b" },
    { source: "a", target: "c" },
  ]);
  expect(d.a).toBe(2);
  expect(d.b).toBe(1);
  expect(d.c).toBe(1);
});

test("graph labels are truncated before layout", () => {
  expect(graphLabelText("short label")).toBe("short label");
  expect(
    graphLabelText(
      "cc-connect Slack architecture and why official Claude-Code-in-Slack is not viable",
    ),
  ).toBe("cc-connect Slack architecture...");
});

test("label box overlap includes optional padding", () => {
  expect(
    labelBoxesOverlap({ x0: 0, x1: 10, y0: 0, y1: 10 }, { x0: 12, x1: 20, y0: 0, y1: 10 }),
  ).toBe(false);
  expect(
    labelBoxesOverlap({ x0: 0, x1: 10, y0: 0, y1: 10 }, { x0: 12, x1: 20, y0: 0, y1: 10 }, 3),
  ).toBe(true);
});
