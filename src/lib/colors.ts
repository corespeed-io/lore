// The node-type palette — the single source of truth for type colors across the
// graph, its legend, and the dashboard breakdown. Unknown backend types get a
// stable hash color, so the UI does not need a code change for every new type.
export const TYPE_COLORS: Record<string, string> = {
  person: "#0070f3",
  company: "#7928ca",
  product: "#50e3c2",
  concept: "#8f8f8f",
};

const FALLBACK_COLORS = ["#ff4d4d", "#00a67e", "#f81ce5", "#666666"];

export function typeColor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let hash = 0;
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? TYPE_COLORS.concept;
}
