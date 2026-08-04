import { loadConfig } from "./config";
import { callTool } from "./tools";
import type { GraphData, GraphNode, PageHit } from "./types";

// 1h: the brain's page/link topology changes slowly, and every rebuild fans out
// a traverse_graph call per seed — a long TTL keeps that off the brain request
// log (was 10m, which spammed the log with graph reads).
const TTL_MS = 3_600_000;
// Edges come from a FEW deep traversals, not one shallow call per page.
// traverse_graph(both, depth N) returns the whole reachable neighborhood's edges
// in a single call, so a handful of deep roots cover the graph while keeping the
// the brain request log quiet (was 1 shallow call × up to 60 seeds = 60 reads/build;
// now ~TRAVERSE_ROOTS reads/build). Roots are the most-relevant pages; depth 5
// (the brain's default, cap 10) reaches across the connected brain.
// Titles for the whole brain, paged. The cap is a backstop against a brain
// large enough that resolving every title costs more than the graph is worth;
// past it, nodes fall back to slug labels as they always did.
const TITLE_PAGE = 1000;
const TITLE_CAP = 20_000;

// Isolated pages earn their place in a small brain and drown a large one.
const ISOLATED_BUDGET = 400;

const TRAVERSE_ROOTS = 8;
const TRAVERSE_DEPTH = 5;
let cache: { data: GraphData; at: number } | null = null;
// Single-flight: concurrent cache misses share one rebuild instead of each
// fanning the full list_pages + seed-query + traversal pipeline at the brain.
let inflight: Promise<GraphData> | null = null;

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

// Test-only reset. NOT safe to call while a rebuild is in flight: there is no
// generation fencing, so a pending rebuild still writes `cache` when it
// settles (and its .finally clears a successor's inflight registration).
export function clearGraphCache(): void {
  cache = null;
  inflight = null;
}

interface LinkRow {
  from_slug?: string;
  to_slug?: string;
}

// One traverse_graph(direction="both", depth=TRAVERSE_DEPTH) call per selected
// root returns every edge in the root's reachable neighborhood — incoming +
// outgoing — so a few deep reads cover the graph (see TRAVERSE_ROOTS above).
//
// `ok` distinguishes "this root genuinely reached no edges" from "the read
// failed": collapsing both to [] is how a transient brain hiccup silently
// turned the whole graph edgeless (every node degree 0 → uniform scatter).
// A read counts as failed when the call threw, the brain flagged a tool-level
// error (isError — callTool does NOT throw on those), the payload wasn't an
// array, or a non-empty array carried no usable {from_slug, to_slug} rows
// (schema drift: e.g. a backend answering with node rows instead of edges).
async function edgeRows(slug: string, depth: number): Promise<{ rows: LinkRow[]; ok: boolean }> {
  try {
    const { isError, text } = await callTool("traverse_graph", { slug, depth, direction: "both" });
    if (isError) return { rows: [], ok: false };
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return { rows: [], ok: false };
    const rows = (parsed as LinkRow[]).filter(
      (r) => typeof r?.from_slug === "string" && typeof r?.to_slug === "string",
    );
    return { rows, ok: parsed.length === 0 || rows.length > 0 };
  } catch {
    return { rows: [], ok: false };
  }
}

export async function buildGraph(): Promise<GraphData> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!inflight) {
    inflight = rebuild().finally(() => {
      inflight = null;
    });
    // One handler at creation — attaching per stale-served request logged N
    // identical warnings for one failed rebuild. Cold-path awaiters still see
    // the rejection through their own await; an extra .catch does not consume it.
    inflight.catch((err) => {
      // Only the stale path is silent about failures; the cold path surfaces
      // its own error through the route. Don't claim "serving stale" when
      // there is nothing to serve.
      if (cache)
        console.warn("graph: background rebuild failed — serving stale until one succeeds", err);
    });
  }
  // Stale-while-revalidate: a rebuild takes 10-48s of brain traversals, and the
  // pre-SWR shape made the first visitor after every TTL expiry stare at an
  // empty graph for all of it — the largest single latency in the app, paid by
  // whoever shows up at the wrong hour. An expired-but-real graph is served NOW
  // and the (single-flighted) rebuild replaces it in the background; "stale
  // beats 502" already conceded that an old graph is fine to show, so waiting
  // was never buying correctness. A failed background rebuild just leaves the
  // cache expired — the next request kicks off another attempt and is served
  // stale again, which is the same "don't hammer a degraded brain" behaviour
  // the failure path always had. Only the first-ever build (nothing to serve)
  // still blocks.
  if (cache) return cache.data;
  return await inflight;
}

async function rebuild(): Promise<GraphData> {
  const cfg = loadConfig();
  // Every upstream read feeds ONE failure signal. Seed-phase failures used to
  // be invisible (caught to []), which let a total the brain outage cache an
  // EMPTY graph as healthy for the full TTL — and let an all-seed-query
  // failure silently fall back to recency-ordered roots, the exact
  // scattered-graph regression this module guards against.
  let seedReadFailed = false;
  // 1. Seed: candidate pages from the seed queries. This anchors the graph on the
  // pages the brain considers relevant and gives us their real titles + types.
  const seedResults = await Promise.all(
    cfg.seedQueries.map(async (q): Promise<PageHit[]> => {
      try {
        const { isError, text } = await callTool("query", { query: q, limit: 40 });
        const parsed = isError ? null : JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to the failure mark below
      }
      seedReadFailed = true;
      return [];
    }),
  );
  const titles = new Map<string, { title: string; type?: string }>();
  try {
    // EVERY page, not the first hundred. A node whose title is missing falls
    // back to its slug's last segment, so on a brain of a few thousand pages a
    // wall of pull requests rendered as the bare numbers 388, 216, 44 — the
    // titles were in the database the whole time, and nothing had asked for them.
    const pages: PageHit[] = [];
    let isError = false;
    for (let offset = 0; offset < TITLE_CAP; offset += TITLE_PAGE) {
      const res = await callTool("list_pages", {
        limit: TITLE_PAGE,
        offset,
        sort: "updated_desc",
      });
      if (res.isError) {
        isError = true;
        break;
      }
      const batch = JSON.parse(res.text);
      if (!Array.isArray(batch) || !batch.length) break;
      pages.push(...(batch as PageHit[]));
      if (batch.length < TITLE_PAGE) break;
    }
    // An EMPTY brain is not a failed read. Treating "no pages" as a failure is
    // how a fresh install started answering 502 instead of an empty graph.
    if (!isError) {
      for (const page of pages) {
        if (!page.slug || titles.has(page.slug)) continue;
        titles.set(page.slug, { title: page.title ?? page.slug, type: page.type });
      }
    } else {
      seedReadFailed = true;
    }
  } catch {
    // The query seeds below still produce a graph when list_pages is unavailable.
    seedReadFailed = true;
  }
  for (const items of seedResults) {
    for (const it of items) {
      if (!it.slug || titles.has(it.slug)) continue;
      titles.set(it.slug, { title: it.title ?? it.slug, type: it.type });
    }
  }
  // 2. Edges from the brain's ACTUAL link graph (incoming + outgoing) via a few deep
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
  // Hash-titled mem0 imports are dropped from the viz anyway, so don't let them
  // consume one of the few root slots.
  const rankedSlugs: string[] = [];
  const deepest = Math.max(0, ...seedResults.map((r) => r.length));
  for (let i = 0; i < deepest; i++)
    for (const hits of seedResults) {
      const hit = hits[i];
      if (hit?.slug && !isHashTitle(hit.title ?? "")) rankedSlugs.push(hit.slug);
    }
  const recentSlugs = [...titles.entries()]
    .filter(([, t]) => !isHashTitle(t.title))
    .map(([slug]) => slug);
  const roots = [...new Set([...rankedSlugs, ...recentSlugs])].slice(0, TRAVERSE_ROOTS);
  const traversals = await Promise.all(roots.map((s) => edgeRows(s, TRAVERSE_DEPTH)));
  const rows = traversals.flatMap((t) => t.rows);
  const failedTraversals = traversals.filter((t) => !t.ok).length;
  const anyReadFailed = seedReadFailed || failedTraversals > 0;

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
  // Isolated pages are shown only while there are few enough for "this page has
  // no links yet" to be the useful reading. Past that they stop being
  // information and become a halo: at 4,113 pages, 2,731 of the nodes had degree
  // zero — 66% of the picture was a ring of dots that said nothing, drawn around
  // the structure someone actually came to look at.
  // Gate on what the graph WOULD become, not on the connected count alone:
  // `nodes` holds only edge endpoints here, so an edgeless 4,000-page brain
  // measured 0 and sailed under the budget — the guard was loosest exactly
  // when the halo it exists to prevent was worst.
  const isolatedCandidates = [...titles.keys()].filter((slug) => !nodes.has(slug));
  if (nodes.size + isolatedCandidates.length <= ISOLATED_BUDGET)
    for (const slug of isolatedCandidates) ensure(slug);

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
  // Zero fetched edges is normal only when the brain truly has none: one
  // healthy root returns its whole reachable neighborhood. Zero fetched edges
  // WHILE an upstream read failed means the emptiness is a hiccup — surface it
  // (route → 502, uncached) instead of presenting a misleading "everything
  // scattered" (or empty) graph as healthy. Gate on the PRE-filter edge set: a
  // brain whose every edge touches a hash-titled page is legitimately edgeless
  // after filtering and must not 502.
  if (!edges.size && anyReadFailed)
    throw new Error(
      `graph: upstream reads failed (seed phase failed: ${seedReadFailed}, traversals failed: ${failedTraversals}/${roots.length}) — refusing to serve an edgeless graph`,
    );
  // A degraded-but-nonempty build (some reads failed, edges survived) is served
  // but NOT cached, so the next request retries instead of pinning a possibly
  // partial graph for the full TTL.
  if (anyReadFailed) {
    console.warn(
      `graph: ${failedTraversals}/${roots.length} traversals failed${seedReadFailed ? " (and a seed read failed)" : ""} — serving uncached, possibly partial graph`,
    );
    return data;
  }
  cache = { data, at: Date.now() };
  return data;
}
