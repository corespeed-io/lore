// The threat these cover is not "the hash is wrong" — it is that TWO PAGE TYPES
// RENDER AS THE SAME SWATCH, which makes the graph legend lie about what the
// picture shows. That shipped: a four-slot fallback palette put `specs` and
// `contribution` both on #ff4d4d, so a legend listing four types had three
// colors in it and 40 nodes were one indistinguishable class.
//
// So the assertion is on DISTINCTNESS across a set of type names, not on any
// particular color — pinning hexes would just re-encode the current palette and
// break on every design change while still allowing a collision.
import { describe, expect, it } from "vitest";
import { TYPE_COLORS, typeColor } from "../src/lib/colors";

// The four lore infers from slug prefixes, plus type names a real deployment
// invents. `specs`/`contribution` are the pair that actually collided.
const TYPES = [
  "person",
  "company",
  "product",
  "concept",
  "topic",
  "specs",
  "contribution",
  "pr",
  "note",
  "memory",
];

describe("type colors", () => {
  it("gives every type its own color, so the legend cannot show one swatch for two types", () => {
    const seen = new Map<string, string>();
    for (const type of TYPES) {
      const color = typeColor(type);
      const clash = seen.get(color);
      expect(clash, `"${type}" and "${clash}" are both ${color}`).toBeUndefined();
      seen.set(color, type);
    }
    expect(seen.size).toBe(TYPES.length);
  });

  // The graph, its legend and the dashboard breakdown each call typeColor
  // separately for the same type. If it were not a pure function of the name
  // they would disagree about what a color means.
  it("answers the same color every time for one type", () => {
    for (const type of TYPES) expect(typeColor(type)).toBe(typeColor(type));
    expect(typeColor("topic")).toBe(typeColor("topic"));
  });

  it("keeps the four named types on their designed colors", () => {
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      expect(typeColor(type)).toBe(color);
    }
  });
});
