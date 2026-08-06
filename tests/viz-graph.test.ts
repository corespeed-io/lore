import { expect, test } from "vitest";
import {
  degrees,
  graphLabelText,
  holdVerdict,
  labelBoxesOverlap,
  labelsToHide,
} from "../src/lib/viz/graph";

test("degrees counts undirected endpoints", () => {
  const d = degrees([
    { source: "a", target: "b", kind: "affinity", weight: 0.8 },
    { source: "a", target: "c", kind: "affinity", weight: 0.6 },
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

// These pin the delta-paint optimization: only labels that were visible and
// are absent from the next visible set should receive another DOM write.
test("a label that was shown and no longer is gets hidden", () => {
  expect([...labelsToHide(["a", "b", "c"], new Set(["a"]))].sort()).toEqual(["b", "c"]);
});

test("a label that was already hidden is not written to again", () => {
  expect(labelsToHide(["a"], new Set(["a"])).size).toBe(0);
});

test("nothing is hidden on the first paint, since every label starts hidden", () => {
  expect(labelsToHide([], new Set(["a", "b"])).size).toBe(0);
});

test("hiding is decided against the new shown set", () => {
  const afterA = new Set(["a1", "a2"]);
  const afterB = new Set(["b1"]);
  expect([...labelsToHide(afterA, afterB)].sort()).toEqual(["a1", "a2"]);
  expect(labelsToHide(afterB, afterB).size).toBe(0);
});

// Drag release keeps focus until the pointer really moves. This rule covers
// both node circles and the transparent edge hit layer.
test("release jitter under 6px never ends the hold", () => {
  for (const target of ["circle", "incident-edge", "other"] as const) {
    expect(holdVerdict(35, target)).toBe("hold");
    expect(holdVerdict(0, target)).toBe("hold");
  }
});

test("real travel onto a focus-bearing target keeps focus", () => {
  expect(holdVerdict(36, "circle")).toBe("release");
  expect(holdVerdict(36, "incident-edge")).toBe("release");
});

test("real travel onto anything else clears focus", () => {
  expect(holdVerdict(36, "other")).toBe("release-clear");
  expect(holdVerdict(10_000, "other")).toBe("release-clear");
});
