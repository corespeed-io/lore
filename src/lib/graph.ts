import { loadConfig } from "./config.js";
import { callTool } from "./gbrain.js";
import type { GraphData, GraphNode, PageHit } from "./types.js";

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const TTL_MS = 600_000;
let cache: { data: GraphData; at: number } | null = null;

export function parseWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WIKILINK)) out.push(m[1].trim());
  return out;
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
  const data: GraphData = {
    nodes: [...nodes.values()],
    links: [...edges].map((e) => {
      const [source, target] = e.split("|");
      return { source, target };
    }),
  };
  cache = { data, at: Date.now() };
  return data;
}
