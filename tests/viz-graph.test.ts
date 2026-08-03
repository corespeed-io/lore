import { expect, test } from "vitest";
import { degrees, graphLabelText, labelBoxesOverlap, labelsToHide } from "../src/lib/viz/graph.js";

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

// The threat: a repaint that gets the hide set wrong fails in one of two ways,
// and NEITHER is visible in review. Too wide (every label that is not shown) is
// a silent 30x write amplification — identical on screen, just slow enough that
// hover cannot keep up with pointermove. Too narrow (no hide at all) leaves the
// PREVIOUS hover's labels on screen, a visual bug that only appears while
// someone is moving a pointer. So these assert the set, not the DOM.
test("a label that was shown and no longer is gets hidden", () => {
  const hide = labelsToHide(["a", "b", "c"], new Set(["a"]));
  expect([...hide].sort()).toEqual(["b", "c"]);
});

test("a label that was already hidden is not written to again", () => {
  // "d" was never on screen. Including it would be the 30x amplification.
  const hide = labelsToHide(["a"], new Set(["a"]));
  expect(hide.size).toBe(0);
});

test("nothing is hidden on the first paint, since every label starts hidden", () => {
  expect(labelsToHide([], new Set(["a", "b"])).size).toBe(0);
});

test("hiding is decided against the shown set, not against a stale copy of it", () => {
  // Hovering A then B must hide A's labels: B's set does not contain them.
  const afterA = new Set(["a1", "a2"]);
  const afterB = new Set(["b1"]);
  expect([...labelsToHide(afterA, afterB)].sort()).toEqual(["a1", "a2"]);
  // ...and re-showing the same set hides nothing.
  expect(labelsToHide(afterB, afterB).size).toBe(0);
});
