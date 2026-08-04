"use client";

import { GraphView } from "@/components/GraphView";
import { LocalGraphModal } from "@/components/LocalGraphModal";
import { Overview } from "@/components/Overview";
import { PageView } from "@/components/PageView";
import { SearchResults } from "@/components/SearchResults";
import { Sidebar } from "@/components/Sidebar";
import { apiCall } from "@/lib/api";
import { type RouteState, type Tab, parseRoute, routeUrl } from "@/lib/route";
import type { GraphData, PageHit } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

const TAB_LABELS: Record<Tab, string> = {
  overview: "Dashboard",
  graph: "Graph",
  search: "Memories",
};

// One page of the browse list. `list_pages` takes an offset now — the 100-row
// cap was gbrain's, inherited when lore proxied it — so the dashboard's PAGES
// count is the real one rather than "the first hundred". It said 100 of 3,379.
const PAGE_LIST_LIMIT = 1000;
// A backstop, not a limit anyone should hit: past this the browse list stops
// growing and says so, instead of pulling a brain of any size into the tab.
const PAGE_LIST_CAP = 20_000;

interface GraphStore {
  nodes: GraphData["nodes"];
  links: GraphData["links"];
  byId: Record<string, GraphData["nodes"][number]>;
  adj: Record<string, Set<string>>;
}

interface PageLink {
  slug: string;
  title: string;
}

interface PageState {
  title: string;
  type: string;
  slug: string;
  body: string;
  backlinks: PageLink[];
  outgoing: PageLink[];
  related: PageLink[];
}

interface AppProps {
  appTitle: string;
  appSubtitle: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function buildGraph(g: GraphData): GraphStore {
  const byId: GraphStore["byId"] = {};
  const adj: GraphStore["adj"] = {};
  for (const n of g.nodes) {
    byId[n.id] = n;
    adj[n.id] = new Set([n.id]);
  }
  for (const l of g.links) {
    if (!adj[l.source]) adj[l.source] = new Set();
    adj[l.source].add(l.target);
    if (!adj[l.target]) adj[l.target] = new Set();
    adj[l.target].add(l.source);
  }
  return { nodes: g.nodes, links: g.links, byId, adj };
}

function graphNeighbors(g: GraphStore | null, slug: string): PageLink[] {
  if (!g?.adj[slug]) return [];
  return [...g.adj[slug]]
    .filter((s) => s !== slug)
    .map((s) => ({ slug: s, title: g.byId[s]?.label ?? s }));
}

function sameLinks(a: PageLink[], b: PageLink[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((link, i) => link.slug === b[i]?.slug && link.title === b[i]?.title);
}

function humanizeSlug(slug: string): string {
  return (slug.split("/").pop() ?? slug).replace(/-/g, " ");
}

function linkTitle(slug: string, label: string | undefined, g: GraphStore | null): string {
  return label?.trim() || g?.byId[slug]?.label || humanizeSlug(slug);
}

function extractWikiLinks(body: string, currentSlug: string, g: GraphStore | null): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];
  const text = (body ?? "").replace(/```[\s\S]*?```/g, " ");
  for (const match of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const slug = match[1]?.trim();
    if (!slug || slug === currentSlug || seen.has(slug)) continue;
    seen.add(slug);
    links.push({ slug, title: linkTitle(slug, match[2], g) });
  }
  return links;
}

function uniquePageLinks(links: PageLink[]): PageLink[] {
  const seen = new Set<string>();
  const unique: PageLink[] = [];
  for (const link of links) {
    if (!link.slug || seen.has(link.slug)) continue;
    seen.add(link.slug);
    unique.push(link);
  }
  return unique;
}

function normalizeBacklinks(raw: unknown, g: GraphStore | null): PageLink[] {
  if (!Array.isArray(raw)) return [];
  return uniquePageLinks(
    raw
      .map((item) => {
        const entry = item as {
          slug?: string;
          title?: string;
          from_slug?: string;
          from_title?: string;
          source_slug?: string;
          source_title?: string;
        };
        const slug = (entry.slug ?? entry.from_slug ?? entry.source_slug ?? "").trim();
        if (!slug) return null;
        return {
          slug,
          title: linkTitle(slug, entry.title ?? entry.from_title ?? entry.source_title, g),
        };
      })
      .filter((link): link is PageLink => Boolean(link)),
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function App({ appTitle, appSubtitle }: AppProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [graph, setGraph] = useState<GraphStore | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const [graphFocus, setGraphFocus] = useState<string | undefined>();
  const [localGraphSlug, setLocalGraphSlug] = useState<string | null>(null);

  // The open memory page; overlays whatever tab you came from (null = show the tab).
  const [openPage, setOpenPage] = useState<PageState | null>(null);

  // Search tab state
  const [searchItems, setSearchItems] = useState<PageHit[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [allPages, setAllPages] = useState<PageHit[]>([]);
  const [memoryType, setMemoryType] = useState("all");

  const searchRef = useRef<HTMLInputElement>(null);
  const graphRef = useRef<GraphStore | null>(null);
  // Sticky "the graph tab has been visited": the persistent GraphView below
  // mounts on first visit and is then hidden, never unmounted (see the comment
  // at the render). A ref, not state — it only ever flips true during a render
  // that is already showing the graph, so no extra render is needed.
  const graphEverVisible = useRef(false);
  const applyingRouteRef = useRef(false);
  const openPageSlug = openPage?.slug;
  graphRef.current = graph;

  // Resolve a slug to a page and open it as the overlay.
  const showPage = useCallback(
    (
      title: string,
      type: string,
      slug: string,
      body: string,
      backlinks: PageLink[],
      outgoing: PageLink[],
      related: PageLink[],
    ) => {
      setOpenPage({ title, type, slug, body, backlinks, outgoing, related });
      window.scrollTo(0, 0);
    },
    [],
  );

  // Ref to break circular deps
  const openPageRef = useRef<((slug: string, g: GraphStore | null) => Promise<void>) | undefined>(
    undefined,
  );

  const openGraphNode = useCallback((slug: string, g: GraphStore | null) => {
    openPageRef.current?.(slug, g);
  }, []);

  // Latest-wins: opening pages in quick succession raced their responses — the
  // SLOWER open painted last and clobbered the page the user actually asked for,
  // and a response landing after Back re-opened the page that was just closed.
  // Every navigation bumps the sequence; a response that comes back to find a
  // newer sequence belongs to an abandoned navigation and paints nothing.
  const pageReq = useRef(0);

  const resolvePage = useCallback(
    async (slug: string, g: GraphStore | null) => {
      const req = ++pageReq.current;
      const fresh = () => pageReq.current === req;
      try {
        // get_backlinks takes the same input slug, not get_page's result — the
        // two are independent, and serial awaits doubled every page open.
        const [page, back] = await Promise.all([
          apiCall("get_page", { slug, fuzzy: true }) as Promise<{
            title?: string;
            slug: string;
            type?: string;
            compiled_truth?: string;
            body?: string;
          }>,
          apiCall("get_backlinks", { slug }).catch(() => []),
        ]);
        if (!fresh()) return;
        const currentGraph = g ?? graphRef.current;
        const bl = normalizeBacklinks(back, currentGraph);
        const body = page.compiled_truth ?? page.body ?? "";
        showPage(
          page.title ?? page.slug,
          page.type ?? "",
          page.slug,
          body,
          bl,
          extractWikiLinks(body, page.slug, currentGraph),
          graphNeighbors(currentGraph, page.slug),
        );
      } catch (e) {
        try {
          const stem = (slug.split("/").pop() ?? slug).replace(/-/g, " ");
          const res = (await apiCall("query", { query: stem })) as PageHit[];
          const hit = Array.isArray(res)
            ? (res.find((r) => r.slug === slug) ??
              res.find((r) => r.slug?.split("/").pop() === slug.split("/").pop()))
            : undefined;
          if (hit) {
            if (!fresh()) return;
            showPage(
              hit.title ?? hit.slug,
              hit.type ?? "",
              hit.slug,
              hit.chunk_text ?? "",
              [],
              extractWikiLinks(hit.chunk_text ?? "", hit.slug, g ?? graphRef.current),
              graphNeighbors(g ?? graphRef.current, hit.slug),
            );
            return;
          }
        } catch (_) {
          // ignore fallback error
        }
        if (!fresh()) return;
        const msg = (e as Error).message ?? "";
        const notFound = /not_found/.test(msg);
        showPage(notFound ? "Page not found" : "Couldn't load page", "", slug, "", [], [], []);
      }
    },
    [showPage],
  );

  openPageRef.current = resolvePage;

  const goToSlug = useCallback(
    (slug: string, g: GraphStore | null) => {
      if (!slug) return;
      if (g?.byId[slug]) openGraphNode(slug, g);
      else resolvePage(slug, g);
    },
    [openGraphNode, resolvePage],
  );

  const writeRoute = useCallback((route: RouteState, mode: "push" | "replace" = "push") => {
    if (applyingRouteRef.current) return;
    const url = routeUrl(route);
    if (window.location.pathname + window.location.search === url) return;
    window.history[mode === "push" ? "pushState" : "replaceState"](route, "", url);
  }, []);

  const currentBaseRoute = useCallback((): RouteState => {
    const route = parseRoute(window.location.pathname, window.location.search);
    const routeQuery = (route.q ?? "").trim();
    const stateQuery = searchQuery.trim();
    const query = routeQuery || stateQuery;
    const type = route.type ?? memoryType;
    return {
      tab: route.tab,
      q: route.tab === "search" ? query || undefined : undefined,
      type: route.tab === "search" && !query ? type : undefined,
      focus: route.tab === "graph" ? route.focus : undefined,
    };
  }, [searchQuery, memoryType]);

  // Open a memory from anywhere — dashboard, memories, graph, wikilinks.
  const openMemory = useCallback(
    (slug: string) => {
      writeRoute({ ...currentBaseRoute(), page: slug });
      goToSlug(slug, graphRef.current);
    },
    [currentBaseRoute, goToSlug, writeRoute],
  );

  const openFocusedGraph = useCallback(
    (slug: string) => {
      setLocalGraphSlug(null);
      setOpenPage(null);
      setTab("graph");
      setGraphFocus(slug);
      writeRoute({ tab: "graph", focus: slug });
    },
    [writeRoute],
  );

  const resetGraphFilter = useCallback(() => {
    setGraphFocus(undefined);
    writeRoute({ tab: "graph" }, "replace");
  }, [writeRoute]);

  // Load graph on mount
  useEffect(() => {
    async function loadGraph() {
      try {
        const r = await fetch("/api/graph");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const g = (await r.json()) as GraphData;
        const store = buildGraph(g);
        setGraph(store);
        setGraphData(g);
      } catch (e) {
        setGraphError((e as Error).message ?? String(e));
      } finally {
        setGraphLoaded(true);
      }
    }
    loadGraph();
  }, []);

  useEffect(() => {
    if (!graph || !openPageSlug) return;
    setOpenPage((page) => {
      if (!page) return page;
      const related = graphNeighbors(graph, page.slug);
      return sameLinks(page.related, related) ? page : { ...page, related };
    });
  }, [graph, openPageSlug]);

  // Load the page list once → the Memories browse (default, no query).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all: PageHit[] = [];
      for (let offset = 0; offset < PAGE_LIST_CAP; offset += PAGE_LIST_LIMIT) {
        const batch = await apiCall("list_pages", {
          limit: PAGE_LIST_LIMIT,
          offset,
          sort: "updated_desc",
        }).catch(() => null);
        if (cancelled || !Array.isArray(batch) || !batch.length) break;
        all.push(...(batch as PageHit[]));
        // Paint the first batch immediately; a big brain should not stare at
        // zeros while the rest arrives.
        setAllPages([...all]);
        if ((batch as PageHit[]).length < PAGE_LIST_LIMIT) break;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(async (query: string) => {
    try {
      const items = (await apiCall("search", { query, limit: 25 })) as PageHit[];
      setSearchItems(Array.isArray(items) ? items : []);
    } catch (_) {
      setSearchItems([]);
    }
  }, []);

  async function handleSearch(q: string) {
    const query = q.trim();
    if (searchRef.current && searchRef.current.value !== q) searchRef.current.value = q;
    setLocalGraphSlug(null);
    setSearchQuery(query);
    if (!query) {
      setSearchItems([]);
      if (tab === "search" && !openPage) writeRoute({ tab: "search", type: memoryType }, "replace");
      return;
    }
    setOpenPage(null);
    setTab("search");
    writeRoute({ tab: "search", q: query }, tab === "search" && !openPage ? "replace" : "push");
    await runSearch(query);
  }

  function handleTabChange(t: Tab) {
    pageReq.current++; // abandon any in-flight page open — it must not pop in later
    setOpenPage(null); // any nav click leaves an open memory
    setLocalGraphSlug(null);
    setGraphFocus(undefined);
    if (t === "search") {
      // Memories tab: reset to the full browse (clear any prior search + filter).
      setSearchQuery("");
      setSearchItems([]);
      setMemoryType("all");
      if (searchRef.current) searchRef.current.value = "";
    }
    setTab(t);
    writeRoute({ tab: t });
  }

  // Dashboard → Memories, pre-filtered to a type (drill-down from the By-type panel).
  function drillType(type: string) {
    setOpenPage(null);
    setLocalGraphSlug(null);
    setSearchQuery("");
    setSearchItems([]);
    if (searchRef.current) searchRef.current.value = "";
    setMemoryType(type);
    setTab("search");
    writeRoute({ tab: "search", type });
  }

  const applyRoute = useCallback(
    (route: RouteState) => {
      applyingRouteRef.current = true;
      setOpenPage(null);
      setLocalGraphSlug(null);
      setTab(route.tab);
      setGraphFocus(route.tab === "graph" ? route.focus : undefined);

      const q = (route.q ?? "").trim();
      const type = route.type ?? "all";
      setSearchQuery(q);
      setMemoryType(type);
      if (searchRef.current) searchRef.current.value = q;

      if (q) void runSearch(q);
      else setSearchItems([]);

      if (route.page) goToSlug(route.page, graphRef.current);
      else window.scrollTo(0, 0);

      window.setTimeout(() => {
        applyingRouteRef.current = false;
      }, 0);
    },
    [goToSlug, runSearch],
  );

  useEffect(() => {
    const initialRoute = parseRoute(window.location.pathname, window.location.search);
    window.history.replaceState(initialRoute, "", routeUrl(initialRoute));
    applyRoute(initialRoute);

    const onPopState = () =>
      applyRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyRoute]);

  // The graph, once shown, stays MOUNTED and is hidden with display:none rather
  // than unmounted. Unmounting it made every tab switch and every page open
  // destroy the whole d3 graph — and the return paid a fresh mount: a ~400ms
  // headless settle, a re-fit, and the loss of whatever zoom/pan/selection the
  // user had. display:none costs nothing per frame, and the mount effect's deps
  // ([data, handleSelect]) don't change on a hide, so d3 state survives intact.
  // Safe with the graph's own ResizeObserver: a hidden container measures 0 and
  // mountGraph's `el.clientWidth || W` fallback turns that read into a no-op.
  // Lazy on FIRST visit on purpose — someone who never opens the graph tab
  // never pays the settle at all.
  const graphReady = graphLoaded && !graphError && graphData.nodes.length > 0;
  const graphVisible = tab === "graph" && !openPage && graphReady;
  if (graphVisible) graphEverVisible.current = true; // monotonic latch, render-safe

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={tab}
        onTabChange={handleTabChange}
        onSearch={handleSearch}
        searchRef={searchRef}
      />

      <main className="app-main">
        {graphEverVisible.current && graphReady && (
          <div className="view-anim" style={graphVisible ? undefined : { display: "none" }}>
            <GraphView
              data={graphData}
              focusSlug={graphFocus}
              onOpen={openMemory}
              onResetFilter={resetGraphFilter}
            />
          </div>
        )}
        {!graphVisible && (
          <div className="view-anim" key={openPage ? `page:${openPage.slug}` : `tab:${tab}`}>
            {openPage ? (
              <PageView
                title={openPage.title}
                type={openPage.type}
                slug={openPage.slug}
                body={openPage.body}
                backlinks={openPage.backlinks}
                outgoing={openPage.outgoing}
                related={openPage.related}
                backLabel={TAB_LABELS[tab]}
                onBack={() => {
                  pageReq.current++; // a response landing after Back must not re-open the page
                  setOpenPage(null);
                  setLocalGraphSlug(null);
                  writeRoute(currentBaseRoute(), "replace");
                }}
                onOpen={openMemory}
                onLocalGraph={setLocalGraphSlug}
              />
            ) : (
              <>
                {tab === "overview" && (
                  <Overview
                    appTitle={appTitle}
                    appSubtitle={appSubtitle}
                    graphData={graphData}
                    graphError={graphError}
                    allPages={allPages}
                    onOpen={openMemory}
                    onType={drillType}
                    onNavigate={handleTabChange}
                  />
                )}

                {/* The ready graph renders in the persistent container above; only
                  the placeholder states live here, where remounting is free. */}
                {tab === "graph" &&
                  (!graphLoaded ? (
                    <div style={{ padding: "40px 24px", color: "var(--muted)" }}>
                      Loading graph…
                    </div>
                  ) : graphError ? (
                    <div style={{ padding: "40px 24px", color: "var(--muted)" }}>
                      Couldn't reach the brain — {graphError}. Check that <code>DATABASE_URL</code>{" "}
                      points at a running Postgres; the dashboard's Read API panel shows recent call
                      status.
                    </div>
                  ) : graphData.nodes.length === 0 ? (
                    <div style={{ padding: "40px 24px", color: "var(--muted)" }}>
                      No linked pages in this brain yet. Lore graphs pages connected by
                      <code>[[wikilinks]]</code> — add some, or import a folder at /import.
                    </div>
                  ) : null)}

                {tab === "search" && (
                  <SearchResults
                    items={searchItems}
                    allPages={allPages}
                    query={searchQuery}
                    typeFilter={memoryType}
                    onTypeFilter={setMemoryType}
                    onOpen={openMemory}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>
      {localGraphSlug && graphData.nodes.length > 0 && (
        <LocalGraphModal
          data={graphData}
          focusSlug={localGraphSlug}
          title={graph?.byId[localGraphSlug]?.label ?? humanizeSlug(localGraphSlug)}
          onClose={() => setLocalGraphSlug(null)}
          onOpen={openMemory}
          onOpenGraph={openFocusedGraph}
        />
      )}
    </div>
  );
}
