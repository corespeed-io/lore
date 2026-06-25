"use client";

import { GraphView } from "@/components/GraphView";
import { Header } from "@/components/Header";
import { Overview } from "@/components/Overview";
import { PageView } from "@/components/PageView";
import { SearchResults } from "@/components/SearchResults";
import type { GraphData, PageHit } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

type Tab = "overview" | "graph" | "search";

interface GraphStore {
  nodes: GraphData["nodes"];
  links: GraphData["links"];
  byId: Record<string, GraphData["nodes"][number]>;
  adj: Record<string, Set<string>>;
}

interface PageState {
  title: string;
  type: string;
  slug: string;
  body: string;
  neighbors: { slug: string; title: string }[];
}

interface AppProps {
  appTitle: string;
  brandColors: Record<string, string>;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

async function apiCall(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const r = await fetch("/api/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? String(r.status));
  }
  const { text, isError } = (await r.json()) as { text: string; isError: boolean };
  if (isError) throw new Error(text || "brain error");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

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

function graphNeighbors(g: GraphStore | null, slug: string): { slug: string; title: string }[] {
  if (!g?.adj[slug]) return [];
  return [...g.adj[slug]]
    .filter((s) => s !== slug)
    .map((s) => ({ slug: s, title: g.byId[s]?.label ?? s }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export function App({ appTitle, brandColors }: AppProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [graph, setGraph] = useState<GraphStore | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [graphError, setGraphError] = useState<string | null>(null);

  // Overview detail panel state
  const [overviewDetail, setOverviewDetail] = useState<PageState | null>(null);

  // Graph-tab page state (full-screen page view from clicking a graph node)
  const [graphPage, setGraphPage] = useState<PageState | null>(null);

  // Search tab state
  const [searchItems, setSearchItems] = useState<PageHit[]>([]);
  const [searchKind, setSearchKind] = useState<"list" | "search">("search");

  const searchRef = useRef<HTMLInputElement>(null);
  const graphRef = useRef<GraphStore | null>(null);
  graphRef.current = graph;

  // Resolve and display a page (shared)
  const showPage = useCallback(
    (
      title: string,
      type: string,
      slug: string,
      body: string,
      neighbors: { slug: string; title: string }[],
      target: "overview" | "graph",
    ) => {
      const state: PageState = { title, type, slug, body, neighbors };
      if (target === "overview") {
        setOverviewDetail(state);
        window.scrollTo(0, 0);
      } else {
        setGraphPage(state);
        setTab("graph");
        window.scrollTo(0, 0);
      }
    },
    [],
  );

  // Ref to break circular deps
  const openPageRef = useRef<
    | ((slug: string, g: GraphStore | null, target: "overview" | "graph") => Promise<void>)
    | undefined
  >(undefined);

  const openGraphNode = useCallback(
    (slug: string, g: GraphStore | null, target: "overview" | "graph") => {
      const n = g?.byId[slug];
      if (n?.text) {
        showPage(n.label, n.type, slug, n.text, graphNeighbors(g, slug), target);
        return;
      }
      openPageRef.current?.(slug, g, target);
    },
    [showPage],
  );

  const openPage = useCallback(
    async (slug: string, g: GraphStore | null, target: "overview" | "graph") => {
      try {
        const page = (await apiCall("get_page", { slug, fuzzy: true })) as {
          title?: string;
          slug: string;
          type?: string;
          compiled_truth?: string;
          body?: string;
        };
        const back = (await apiCall("get_backlinks", { slug }).catch(() => [])) as {
          slug: string;
          title?: string;
        }[];
        const bl = (Array.isArray(back) ? back : []).map((b) => ({
          slug: b.slug,
          title: b.title ?? b.slug,
        }));
        showPage(
          page.title ?? page.slug,
          page.type ?? "",
          page.slug,
          page.compiled_truth ?? page.body ?? "",
          bl,
          target,
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
              graphNeighbors(g, hit.slug),
              target,
            );
            return;
          }
        } catch (_) {
          // ignore fallback error
        }
        const msg = (e as Error).message ?? "";
        const notFound = /not_found/.test(msg);
        showPage(notFound ? "Page not found" : "Couldn't load page", "", slug, "", [], target);
      }
    },
    [showPage],
  );

  openPageRef.current = openPage;

  const goToSlug = useCallback(
    (slug: string, g: GraphStore | null, target: "overview" | "graph") => {
      if (!slug) return;
      if (g?.byId[slug]) {
        openGraphNode(slug, g, target);
      } else {
        openPage(slug, g, target);
      }
    },
    [openGraphNode, openPage],
  );

  // onOpen from overview graph panel → opens in detail panel
  const onOpenOverview = useCallback(
    (slug: string) => {
      goToSlug(slug, graphRef.current, "overview");
    },
    [goToSlug],
  );

  // onOpen from full-screen graph tab → shows page in graph tab
  const onOpenGraph = useCallback(
    (slug: string) => {
      goToSlug(slug, graphRef.current, "graph");
    },
    [goToSlug],
  );

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
      }
    }
    loadGraph();
  }, []);

  async function handleSearch(q: string) {
    if (searchRef.current) searchRef.current.value = q;
    try {
      const items = (await apiCall("query", { query: q })) as PageHit[];
      setSearchItems(items);
      setSearchKind("search");
    } catch (_) {
      setSearchItems([]);
    }
    setTab("search");
  }

  function handleTabChange(t: Tab) {
    if (t === "graph") {
      // Clear graph page when switching back to graph tab
      setGraphPage(null);
    }
    setTab(t);
  }

  return (
    <>
      <Header
        title={appTitle}
        activeTab={tab}
        onTabChange={handleTabChange}
        onSearch={handleSearch}
        searchRef={searchRef}
      />

      {tab === "overview" && (
        <Overview
          graphData={graphData}
          graphError={graphError}
          brandColors={brandColors}
          detailPage={overviewDetail}
          onOpen={onOpenOverview}
        />
      )}

      {tab === "graph" &&
        (graphPage ? (
          <PageView
            title={graphPage.title}
            type={graphPage.type}
            slug={graphPage.slug}
            body={graphPage.body}
            neighbors={graphPage.neighbors}
            inGraph={!!graph?.byId[graphPage.slug]}
            onOpen={(slug) => goToSlug(slug, graph, "graph")}
            onGraph={() => setGraphPage(null)}
          />
        ) : graphData.nodes.length === 0 && !graphError ? (
          <div style={{ padding: "40px 24px", color: "var(--muted)" }}>Loading graph…</div>
        ) : graphError ? (
          <div style={{ padding: "40px 24px", color: "var(--muted)" }}>
            Graph error: {graphError}
          </div>
        ) : (
          <GraphView data={graphData} onOpen={onOpenGraph} brandColors={brandColors} />
        ))}

      {tab === "search" && (
        <SearchResults
          items={searchItems}
          kind={searchKind}
          onOpen={(slug) => goToSlug(slug, graph, "graph")}
        />
      )}
    </>
  );
}
