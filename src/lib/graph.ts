import { loadConfig } from "./config";
import { callTool } from "./gbrain";
import type { GraphData, GraphNode, PageHit } from "./types";

const TTL_MS = 600_000;
// Bound how many seed pages we expand through gbrain's link graph. Real graphs
// have far fewer seed pages than this; the cap just stops a pathological brain
// from firing thousands of link reads.
const EXPAND_CAP = 60;
let cache: { data: GraphData; at: number } | null = null;

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

interface LinkRow {
  from_slug?: string;
  to_slug?: string;
}

async function linkRows(tool: "get_links" | "get_backlinks", slug: string): Promise<LinkRow[]> {
  try {
    const { text } = await callTool(tool, { slug });
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
  for (const items of seedResults) {
    for (const it of items) {
      if (!it.slug || titles.has(it.slug)) continue;
      titles.set(it.slug, { title: it.title ?? it.slug, type: it.type });
    }
  }
  // 2. Edges from gbrain's ACTUAL link graph (outgoing + incoming) for each seed
  // page — not a regex over the search snippet. This surfaces the mentions/manual/
  // typed edges and the wikilinks that live outside the matched chunk, which the
  // old snippet-scan silently dropped.
  const seeds = [...titles.keys()].slice(0, EXPAND_CAP);
  const rows = (
    await Promise.all(
      seeds.flatMap((s) => [linkRows("get_links", s), linkRows("get_backlinks", s)]),
    )
  ).flat();

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
  for (const { from_slug, to_slug } of rows) {
    if (!from_slug || !to_slug || from_slug === to_slug) continue;
    ensure(from_slug);
    ensure(to_slug);
    edges.add([from_slug, to_slug].sort().join("|"));
  }
  // 4. Keep the graph meaningful: drop hash-titled mem0 imports, then isolated
  // nodes (no links). Both stay findable via Search; they just aren't graph nodes.
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
