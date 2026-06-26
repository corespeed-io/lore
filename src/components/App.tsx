"use client";

import { GraphView } from "@/components/GraphView";
import { LocalGraphModal } from "@/components/LocalGraphModal";
import { Overview } from "@/components/Overview";
import { PageView } from "@/components/PageView";
import { SearchResults } from "@/components/SearchResults";
import { Sidebar } from "@/components/Sidebar";
import { apiCall } from "@/lib/api";
import type { GraphData, PageHit } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

type Tab = "overview" | "graph" | "search";

interface RouteState {
  tab: Tab;
  page?: string;
  focus?: string;
  q?: string;
  type?: string;
}

const TAB_LABELS: Record<Tab, string> = {
  overview: "Dashboard",
  graph: "Graph",
  search: "Memories",
};

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (_) {
    return segment;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodePathSegment);
}

function slugFromSegments(segments: string[]): string | undefined {
  return segments.length > 0 ? segments.join("/") : undefined;
}

function slugPath(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}

function queryValue(params: URLSearchParams, key: string): string | undefined {
  return params.get(key) ?? undefined;
}

function parseRoute(pathname: string, search: string): RouteState {
  const params = new URLSearchParams(search);
  const q = queryValue(params, "q");
  const type = queryValue(params, "type");
  const focus = queryValue(params, "focus");
  const segments = pathSegments(pathname);

  if (segments[0] === "graph") {
    if (segments[1] === "page") {
      return {
        tab: "graph",
        page: slugFromSegments(segments.slice(2)),
        focus,
      };
    }
    return {
      tab: "graph",
      focus: slugFromSegments(segments.slice(1)) ?? focus,
    };
  }

  if (segments[0] === "memories") {
    return {
      tab: "search",
      page: slugFromSegments(segments.slice(1)),
      q,
      type,
    };
  }

  if (segments[0] === "page") {
    return {
      tab: "overview",
      page: slugFromSegments(segments.slice(1)),
    };
  }

  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "graph" || tabParam === "search" ? tabParam : "overview";
  return {
    tab,
    page: queryValue(params, "page"),
    focus,
    q,
    type,
  };
}

function routeUrl(route: RouteState): string {
  let path = "/";
  if (route.tab === "graph") {
    if (route.page) path = `/graph/page/${slugPath(route.page)}`;
    else if (route.focus) path = `/graph/${slugPath(route.focus)}`;
    else path = "/graph";
  } else if (route.tab === "search") {
    path = route.page ? `/memories/${slugPath(route.page)}` : "/memories";
  } else if (route.page) {
    path = `/page/${slugPath(route.page)}`;
  }

  const params = new URLSearchParams();
  if (route.tab === "search" && route.q) params.set("q", route.q);
  if (route.tab === "search" && route.type && route.type !== "all") {
    params.set("type", route.type);
  }
  if (route.tab === "graph" && route.page && route.focus) params.set("focus", route.focus);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

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
  brandColors: Record<string, string>;
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

export function App({ appTitle, appSubtitle, brandColors }: AppProps) {
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

  const resolvePage = useCallback(
    async (slug: string, g: GraphStore | null) => {
      try {
        const page = (await apiCall("get_page", { slug, fuzzy: true })) as {
          title?: string;
          slug: string;
          type?: string;
          compiled_truth?: string;
          body?: string;
        };
        const back = await apiCall("get_backlinks", { slug }).catch(() => []);
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

  // Load the full page list once → the Memories browse (default, no query).
  useEffect(() => {
    apiCall("list_pages", { limit: 200, sort: "updated_desc" })
      .then((d) => setAllPages(Array.isArray(d) ? (d as PageHit[]) : []))
      .catch(() => {});
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

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={tab}
        onTabChange={handleTabChange}
        onSearch={handleSearch}
        searchRef={searchRef}
      />

      <main className="app-main">
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
                allPages={allPages}
                onOpen={openMemory}
                onType={drillType}
                onNavigate={handleTabChange}
              />
            )}

            {tab === "graph" &&
              (!graphLoaded ? (
                <div style={{ padding: "40px 24px", color: "var(--muted)" }}>Loading graph…</div>
              ) : graphError ? (
                <div style={{ padding: "40px 24px", color: "var(--muted)" }}>
                  Graph error: {graphError}
                </div>
              ) : graphData.nodes.length === 0 ? (
                <div style={{ padding: "40px 24px", color: "var(--muted)" }}>
                  No graph data. Check GBRAIN_MCP_URL / GBRAIN_TOKEN.
                </div>
              ) : (
                <GraphView
                  data={graphData}
                  focusSlug={graphFocus}
                  onOpen={openMemory}
                  brandColors={brandColors}
                  onResetFilter={resetGraphFilter}
                />
              ))}

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
      </main>
      {localGraphSlug && graphData.nodes.length > 0 && (
        <LocalGraphModal
          data={graphData}
          focusSlug={localGraphSlug}
          title={graph?.byId[localGraphSlug]?.label ?? humanizeSlug(localGraphSlug)}
          brandColors={brandColors}
          onClose={() => setLocalGraphSlug(null)}
          onOpen={openMemory}
          onOpenGraph={openFocusedGraph}
        />
      )}
    </div>
  );
}
