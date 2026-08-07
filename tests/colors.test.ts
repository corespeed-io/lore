import { describe, expect, it } from "vitest";
import { TYPE_COLORS, typeColor } from "../src/lib/colors";

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
  it("gives the deployment vocabulary distinct graph colors", () => {
    const seen = new Map<string, string>();
    for (const type of TYPES) {
      const color = typeColor(type);
      const clash = seen.get(color);
      expect(clash, `"${type}" and "${clash}" are both ${color}`).toBeUndefined();
      seen.set(color, type);
    }
  });

  it("is stable for repeated calls", () => {
    for (const type of TYPES) expect(typeColor(type)).toBe(typeColor(type));
  });

  it("treats inherited object property names as ordinary untrusted types", () => {
    for (const type of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(typeColor(type)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps named types on their designed colors", () => {
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      expect(typeColor(type)).toBe(color);
    }
  });

  it("does not give an unnamed type a named color", () => {
    const named = new Set(Object.values(TYPE_COLORS));
    for (const type of TYPES) {
      if (type in TYPE_COLORS) continue;
      expect(named.has(typeColor(type))).toBe(false);
    }
  });

  it("does not generate red, which is reserved for failure", () => {
    for (const type of TYPES) {
      if (type in TYPE_COLORS) continue;
      const hex = typeColor(type);
      const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
      expect(r > 180 && g < 110 && b < 110).toBe(false);
    }
  });
});
