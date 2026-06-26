import { loadConfig } from "./config";
import { callTool } from "./gbrain";
import type { GraphData, GraphNode, PageHit } from "./types";

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const TTL_MS = 600_000;
let cache: { data: GraphData; at: number } | null = null;

export function parseWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WIKILINK)) out.push(m[1].trim());
  return out;
}

// mem0-migrated pages carry a content-hash as their title (e.g. "7416e83d").
// They're real memories but meaningless as graph labels — drop them from the viz.
export function isHashTitle(label: string): boolean {
  return /^[0-9a-f]{6,}$/i.test(label.trim());
}

export function nodeType(slug: string, given?: string): string {
  if (slug.startsWith("people/")) return "person";
  if (slug.startsWith("companies/")) return "company";
  if (slug.startsWith("entities/")) return "product";
  if (given === "person" || given === "company" || given === "product") return given;
  return "concept";
}

export function clearGraphCache(): void {
  cache = null;
}

export async function buildGraph(): Promise<GraphData> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const cfg = loadConfig();
  const pages = new Map<string, { title: string; type: string; text: string }>();
  for (const q of cfg.seedQueries) {
    let items: PageHit[] = [];
    try {
      const { text } = await callTool("query", { query: q, limit: 40 });
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      continue;
    }
    for (const it of items) {
      if (!it.slug || pages.has(it.slug)) continue;
      pages.set(it.slug, {
        title: it.title ?? it.slug,
        type: nodeType(it.slug, it.type),
        text: it.chunk_text ?? "",
      });
    }
  }
  const nodes = new Map<string, GraphNode>();
  const edges = new Set<string>();
  const ensure = (slug: string) => {
    if (nodes.has(slug)) return;
    const p = pages.get(slug);
    const label = p ? p.title : (slug.split("/").pop() ?? slug).replace(/-/g, " ");
    nodes.set(slug, { id: slug, label, type: nodeType(slug, p?.type), text: p?.text ?? "" });
  };
  for (const [slug, p] of pages) {
    ensure(slug);
    for (const tgt of parseWikilinks(p.text)) {
      if (!tgt || tgt === slug) continue;
      ensure(tgt);
      edges.add([slug, tgt].sort().join("|"));
    }
  }
  // Keep the graph meaningful: drop hash-titled mem0 imports, then drop isolated
  // nodes (no links — scattered specks). Both stay findable via Search; they just
  // don't belong in a connection graph.
  const titled = new Map([...nodes].filter(([, n]) => !isHashTitle(n.label)));
  const linkPairs = [...edges]
    .map((e) => e.split("|") as [string, string])
    .filter(([s, t]) => titled.has(s) && titled.has(t));
  const linked = new Set<string>();
  for (const [s, t] of linkPairs) {
    linked.add(s);
    linked.add(t);
  }
  const data: GraphData = {
    nodes: [...titled.values()].filter((n) => linked.has(n.id)),
    links: linkPairs.map(([source, target]) => ({ source, target })),
  };
  cache = { data, at: Date.now() };
  return data;
}
