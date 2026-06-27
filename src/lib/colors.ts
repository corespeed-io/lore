// The node-type palette — the single source of truth for type colors across the
// graph, its legend, and the dashboard breakdown. Colors are intentionally NOT
// customizable yet (no BRAND_COLORS env); this keeps one consistent palette.
// Keep `--type-*` in src/app/globals.css in sync (CSS can't import this).
export const TYPE_COLORS: Record<string, string> = {
  person: "#0070f3",
  company: "#7928ca",
  product: "#50e3c2",
  concept: "#8f8f8f",
  extract_receipt: "#f5a623",
};

const FALLBACK_COLORS = ["#ff4d4d", "#00a67e", "#f81ce5", "#666666"];

export function typeColor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let hash = 0;
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? TYPE_COLORS.concept;
}
