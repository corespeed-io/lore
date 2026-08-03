// The node-type palette — the single source of truth for type colors across the
// graph, its legend, and the dashboard breakdown. Unknown backend types get a
// stable hash color, so the UI does not need a code change for every new type.
export const TYPE_COLORS: Record<string, string> = {
  person: "#0070f3",
  company: "#7928ca",
  product: "#50e3c2",
  concept: "#8f8f8f",
};

// An unnamed type gets a stable color derived from its name, so a deployment
// whose backend invents a type needs no code change here. A FOUR-SLOT fallback
// palette made that promise false: four types into four buckets collides ~91% of
// the time, and it did — `specs` and `contribution` both landed on #ff4d4d, so a
// legend listing four types showed three swatches and two classes of node were
// the same color in the graph. Spreading the same hash over the hue circle keeps
// the property and takes the buckets from 4 to 360.
//
// Residual, stated rather than hidden: two names can still land within a few
// degrees. Making it impossible means assigning by index over the set of types
// present, which turns this pure function of one string into one that needs the
// whole set — and then the graph, its legend and the dashboard breakdown must be
// given the SAME set or they disagree about what blue means.
//
// Saturation and lightness are fixed so a generated color carries the same
// weight as the four named ones on the near-white canvas. Comma syntax because
// it is universally supported and this is not a place to be clever.
export function typeColor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let hash = 0;
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 72%, 52%)`;
}
