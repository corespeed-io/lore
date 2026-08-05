// The node-type palette used by the Memory Graph renderer.
export const TYPE_COLORS: Record<string, string> = {
  shared: "#171717",
  private: "#0070f3",
  person: "#0070f3",
  company: "#7928ca",
  product: "#50e3c2",
  concept: "#8f8f8f",
};

// A type this file does not name still needs a color, and it has to be a good
// one: a deployment's own vocabulary (a `pr`, a `topic`, a `recipe`) is the
// vocabulary most of its nodes carry, so the generated colors ARE the picture.
//
// Two earlier versions got this wrong in opposite directions. A four-slot
// fallback list collided constantly — four types into four buckets collide
// about 91% of the time, and `specs` and `contribution` did, so the legend
// listed four types and showed three swatches. Deriving a color arithmetically
// instead (`hsl(hash % 360, 72%, 52%)`) removed the collisions and replaced
// them with a worse problem: nothing chose the colors. The largest type in a
// real graph landed on 346° — alarm red — across 92% of the nodes.
//
// So: a hand-picked categorical palette. Every entry is a designed color that
// sits at the same weight as the four named ones on the near-white canvas, no
// entry duplicates a named one (a generated type must not be able to look like
// a `person`), and RED IS DELIBERATELY ABSENT. Red means failure in a UI; it
// should be reachable by naming it above, never by a hash landing on it.
//
// Honest about what this is: `PALETTE[hash % length]` means the palette's
// CONTENTS AND ORDER decide which type gets which color. Adding an entry
// reshuffles every unnamed type. That is the cost of keeping typeColor a pure
// function of one string, so remounting or filtering the graph never changes
// what a color means. Assigning by index over "the set of types present" would
// guarantee distinctness only until that set changed.
//
// Collisions are therefore still possible for a deployment with many types —
// twelve slots, so four types collide about 43% of the time by chance.
// tests/colors.test.ts pins the vocabulary Lore currently uses.
const PALETTE = [
  "#0ea5e9", // sky
  "#0d9488", // teal
  "#059669", // emerald
  "#84cc16", // lime
  "#ca8a04", // ochre
  "#f59e0b", // amber
  "#f97316", // orange
  "#c026d3", // fuchsia
  "#7c3aed", // violet
  "#4f46e5", // indigo
  "#0891b2", // cyan
  "#64748b", // slate
];

export function typeColor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let hash = 0;
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? TYPE_COLORS.concept;
}
