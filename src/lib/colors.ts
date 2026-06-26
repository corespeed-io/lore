// The node-type palette — the single source of truth for type colors across the
// graph, its legend, and the dashboard breakdown. Colors are intentionally NOT
// customizable yet (no BRAND_COLORS env); this keeps one consistent palette.
// Keep `--type-*` in src/app/globals.css in sync (CSS can't import this).
export const TYPE_COLORS: Record<string, string> = {
  person: "#0070f3",
  company: "#7928ca",
  product: "#50e3c2",
  concept: "#8f8f8f",
};
