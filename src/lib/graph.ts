import { loadConfig } from "./config";
import { callTool } from "./gbrain";
import type { GraphData, GraphNode, PageHit } from "./types";

// 1h: the brain's page/link topology changes slowly, and every rebuild fans out
// a traverse_graph call per seed — a long TTL keeps that off the gbrain request
// log (was 10m, which spammed the log with graph reads).
const TTL_MS = 3_600_000;
// Edges come from a FEW deep traversals, not one shallow call per page.
// traverse_graph(both, depth N) returns the whole reachable neighborhood's edges
// in a single call, so a handful of deep roots cover the graph while keeping the
// gbrain request log quiet (was 1 shallow call × up to 60 seeds = 60 reads/build;
// now ~TRAVERSE_ROOTS reads/build). Roots are the most-relevant pages; depth 5
// (gbrain's default, cap 10) reaches across the connected brain.
const TRAVERSE_ROOTS = 8;
const TRAVERSE_DEPTH = 5;
let cache: { data: GraphData; at: number } | null = null;

// mem0-migrated pages carry a content-hash as their title (e.g. "7416e83d").
// They're real memories but meaningless as graph labels — drop them from the viz.
export function isHashTitle(label: string): boolean {
  return /^[0-9a-f]{6,}$/i.test(label.trim());
}

export function nodeType(slug: string, given?: string): string {
  if (given?.trim()) return given.trim();
  if (slug.startsWith("people/")) return "person";
  if (slug.startsWith("companies/")) return "company";
  if (slug.startsWith("entities/")) return "product";
  return "concept";
}

export function clearGraphCache(): void {
  cache = null;
}

interface LinkRow {
  from_slug?: string;
  to_slug?: string;
}

// One bulk call per seed instead of get_links + get_backlinks (two calls):
// traverse_graph with direction="both" at depth 1 returns every edge incident
// to the seed (incoming + outgoing) in a single request, halving the link-read
// volume that floods the gbrain request log.
//
// `ok` distinguishes "this root genuinely reached no edges" from "the read
// failed": collapsing both to [] is how a transient gbrain hiccup silently
// turned the whole graph edgeless (every node degree 0 → uniform scatter).
async function edgeRows(slug: string, depth: number): Promise<{ rows: LinkRow[]; ok: boolean }> {
  try {
    const { text } = await callTool("traverse_graph", { slug, depth, direction: "both" });
    const parsed = JSON.parse(text);
    return { rows: Array.isArray(parsed) ? (parsed as LinkRow[]) : [], ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

export async function buildGraph(): Promise<GraphData> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const cfg = loadConfig();
  // 1. Seed: candidate pages from the seed queries. This anchors the graph on the
  // pages the brain considers relevant and gives us their real titles + types.
  const seedResults = await Promise.all(
    cfg.seedQueries.map(async (q): Promise<PageHit[]> => {
      try {
        const { text } = await callTool("query", { query: q, limit: 40 });
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }),
  );
  const titles = new Map<string, { title: string; type?: string }>();
  try {
    const { text } = await callTool("list_pages", { limit: 100, sort: "updated_desc" });
    const pages = JSON.parse(text);
    if (Array.isArray(pages)) {
      for (const page of pages as PageHit[]) {
        if (!page.slug || titles.has(page.slug)) continue;
        titles.set(page.slug, { title: page.title ?? page.slug, type: page.type });
      }
    }
  } catch {
    // The query seeds below still produce a graph when list_pages is unavailable.
  }
  for (const items of seedResults) {
    for (const it of items) {
      if (!it.slug || titles.has(it.slug)) continue;
      titles.set(it.slug, { title: it.title ?? it.slug, type: it.type });
    }
  }
  // 2. Edges from gbrain's ACTUAL link graph (incoming + outgoing) via a few deep
  // traversals from the most-relevant root pages — not a regex over the search
  // snippet. This surfaces the mentions/manual/typed edges and the wikilinks that
  // live outside the matched chunk, which the old snippet-scan silently dropped.
  //
  // Roots MUST be well-connected pages, not just the newest. A deep traversal
  // from a freshly-created (still-unlinked) page reaches nothing, and the newest
  // pages often are exactly that — so recency-ordered roots (list_pages order)
  // can miss every hub and yield an all-isolated graph. Seed-query hits are
  // relevance-ranked and reliably surface the hubs (entities/companies/people),
  // so seed the roots from them — round-robin across queries so each contributes
  // its top hit — and fall back to recent pages only to fill TRAVERSE_ROOTS.
  const rankedSlugs: string[] = [];
  const deepest = Math.max(0, ...seedResults.map((r) => r.length));
  for (let i = 0; i < deepest; i++)
    for (const hits of seedResults) {
      const slug = hits[i]?.slug;
      if (slug) rankedSlugs.push(slug);
    }
  const roots = [...new Set([...rankedSlugs, ...titles.keys()])].slice(0, TRAVERSE_ROOTS);
  const traversals = await Promise.all(roots.map((s) => edgeRows(s, TRAVERSE_DEPTH)));
  const rows = traversals.flatMap((t) => t.rows);
  const anyTraversalFailed = traversals.some((t) => !t.ok);

  // 3. Assemble undirected nodes + edges. Seed pages keep their real title/type;
  // a link target that wasn't itself a seed gets a slug-derived label.
  const nodes = new Map<string, GraphNode>();
  const edges = new Set<string>();
  const ensure = (slug: string) => {
    if (nodes.has(slug)) return;
    const t = titles.get(slug);
    const label = t ? t.title : (slug.split("/").pop() ?? slug).replace(/-/g, " ");
    nodes.set(slug, { id: slug, label, type: nodeType(slug, t?.type) });
  };
  for (const slug of titles.keys()) ensure(slug);
  for (const { from_slug, to_slug } of rows) {
    if (!from_slug || !to_slug || from_slug === to_slug) continue;
    ensure(from_slug);
    ensure(to_slug);
    edges.add([from_slug, to_slug].sort().join("|"));
  }
  // 4. Drop hash-titled mem0 imports, but keep legitimate isolated pages. The
  // graph should show the brain's current page set, not only connected pages.
  const titled = new Map([...nodes].filter(([, n]) => !isHashTitle(n.label)));
  const linkPairs = [...edges]
    .map((e) => e.split("|") as [string, string])
    .filter(([s, t]) => titled.has(s) && titled.has(t));
  const data: GraphData = {
    nodes: [...titled.values()],
    links: linkPairs.map(([source, target]) => ({ source, target })),
  };
  // One healthy root returns the whole reachable neighborhood, so zero edges is
  // normal only when the brain truly has none. Zero edges WHILE a traversal
  // errored means the emptiness is a gbrain hiccup — surface it (route → 502,
  // NOT cached) instead of caching a misleading "everything scattered" graph for
  // the full 1h TTL.
  if (!data.links.length && anyTraversalFailed)
    throw new Error("graph: link traversals failed — refusing to cache an edgeless graph");
  cache = { data, at: Date.now() };
  return data;
}
