"use client";

import { GraphView } from "@/components/GraphView";
import { Header } from "@/components/Header";
import { PageView } from "@/components/PageView";
import { SearchResults } from "@/components/SearchResults";
import type { GraphData, PageHit } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

type View = "graph" | "list" | "search" | "page";

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

interface ListState {
  items: PageHit[];
  kind: "list" | "search";
  status: string;
}

// ── Pure helpers (no React deps) ────────────────────────────────────────────

// POST /api/call and parse the result text as JSON (or return raw string).
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

// Build byId + adjacency from raw GraphData.
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

// Graph-derived neighbor list for a slug.
function graphNeighbors(g: GraphStore | null, slug: string): { slug: string; title: string }[] {
  if (!g?.adj[slug]) return [];
  return [...g.adj[slug]]
    .filter((s) => s !== slug)
    .map((s) => ({ slug: s, title: g.byId[s]?.label ?? s }));
}

// ── Component ────────────────────────────────────────────────────────────────

export default function Page() {
  const [view, setView] = useState<View>("graph");
  const [graph, setGraph] = useState<GraphStore | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [graphError, setGraphError] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState | null>(null);
  const [listState, setListState] = useState<ListState | null>(null);
  const [status, setStatus] = useState<string>("loading graph…");
  const searchRef = useRef<HTMLInputElement>(null);

  // Stable ref so graph-click callbacks don't re-mount the force sim on each nav.
  const graphRef = useRef<GraphStore | null>(null);
  graphRef.current = graph;

  // Set state to show a page (title/type/slug/body/neighbors).
  const showPage = useCallback(
    (
      title: string,
      type: string,
      slug: string,
      body: string,
      neighbors: { slug: string; title: string }[],
    ) => {
      setView("page");
      setPageState({ title, type, slug, body, neighbors });
      setStatus(slug);
      window.scrollTo(0, 0);
    },
    [],
  );

  // Open a page from the graph cache if it has body text, otherwise fetch.
  // Defined via ref to break the circular dep with openPage.
  const openPageRef = useRef<((slug: string, g: GraphStore | null) => Promise<void>) | undefined>(
    undefined,
  );

  const openGraphNode = useCallback(
    (slug: string, g: GraphStore | null) => {
      const n = g?.byId[slug];
      if (n?.text) {
        showPage(n.label, n.type, slug, n.text, graphNeighbors(g, slug));
        return;
      }
      // No cached body — fall through to network fetch.
      openPageRef.current?.(slug, g);
    },
    [showPage],
  );

  const openPage = useCallback(
    async (slug: string, g: GraphStore | null) => {
      setStatus(slug);
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
        );
      } catch (e) {
        // Canon fallback: get_page only resolves the caller's source. For canon
        // pages use federated query + graph edges (same logic as reference impl).
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
            );
            return;
          }
        } catch (_) {
          // Ignore canon fallback error; fall through to not-found.
        }
        const msg = (e as Error).message ?? "";
        const notFound = /not_found/.test(msg);
        setView("page");
        setPageState({
          title: notFound ? "Page not found" : "Couldn't load page",
          type: "",
          slug,
          body: "",
          neighbors: [],
        });
        setStatus(slug);
      }
    },
    [showPage],
  );

  // Wire the ref so openGraphNode can call openPage without a circular dep.
  openPageRef.current = openPage;

  const goToSlug = useCallback(
    (slug: string, g: GraphStore | null) => {
      if (!slug) return;
      if (g?.byId[slug]) {
        openGraphNode(slug, g);
      } else {
        openPage(slug, g);
      }
    },
    [openGraphNode, openPage],
  );

  // Stable onOpen for GraphView — reads graph state from ref so the D3 sim is
  // never destroyed when the user navigates away and back.
  const onOpen = useCallback(
    (slug: string) => {
      goToSlug(slug, graphRef.current);
    },
    [goToSlug],
  );

  // Load graph on mount — graph is the default view.
  useEffect(() => {
    async function loadGraph() {
      try {
        const r = await fetch("/api/graph");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const g = (await r.json()) as GraphData;
        const store = buildGraph(g);
        setGraph(store);
        setGraphData(g);
        setStatus(`knowledge graph — ${g.nodes.length} nodes · ${g.links.length} links`);
      } catch (e) {
        setGraphError((e as Error).message ?? String(e));
        setStatus("graph error");
      }
    }
    loadGraph();
  }, []);

  function showGraph() {
    if (searchRef.current) searchRef.current.value = "";
    setView("graph");
    const g = graphRef.current;
    setStatus(
      g ? `knowledge graph — ${g.nodes.length} nodes · ${g.links.length} links` : "knowledge graph",
    );
    window.scrollTo(0, 0);
  }

  async function home() {
    if (searchRef.current) searchRef.current.value = "";
    setStatus("recent pages");
    try {
      const items = (await apiCall("list_pages", { limit: 60 })) as PageHit[];
      setView("list");
      setListState({ items, kind: "list", status: "recent pages" });
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    }
  }

  async function search(q: string) {
    setStatus(`results for "${q}"`);
    try {
      const items = (await apiCall("query", { query: q })) as PageHit[];
      setView("search");
      setListState({ items, kind: "search", status: `results for "${q}"` });
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    }
  }

  const isGraphMode = view === "graph";

  return (
    <>
      {isGraphMode && (
        // Suppress global scroll + main padding while graph is fullscreen.
        <style>
          {"body { overflow: hidden; } main { max-width: none !important; padding: 0 !important; }"}
        </style>
      )}
      <Header
        title="gbrain"
        onHome={home}
        onSearch={search}
        onGraph={showGraph}
        searchRef={searchRef}
      />
      {view !== "graph" && (
        <div id="status" style={{ color: "var(--mut)", padding: "6px 20px", fontSize: "13px" }}>
          {status}
        </div>
      )}
      {view === "graph" && (
        <main style={{ maxWidth: "none", padding: 0 }}>
          {graphError ? (
            <div className="mut" style={{ padding: "20px" }}>
              graph error: {graphError}
            </div>
          ) : graphData.nodes.length === 0 ? (
            <div className="mut" style={{ padding: "20px" }}>
              loading graph…
            </div>
          ) : (
            <GraphView data={graphData} onOpen={onOpen} />
          )}
        </main>
      )}
      {(view === "list" || view === "search") && listState && (
        <SearchResults
          items={listState.items}
          kind={listState.kind}
          onOpen={(slug) => goToSlug(slug, graph)}
        />
      )}
      {view === "page" && pageState && (
        <PageView
          title={pageState.title}
          type={pageState.type}
          slug={pageState.slug}
          body={pageState.body}
          neighbors={pageState.neighbors}
          inGraph={!!graph?.byId[pageState.slug]}
          onOpen={(slug) => goToSlug(slug, graph)}
          onGraph={showGraph}
        />
      )}
    </>
  );
}
