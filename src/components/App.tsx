"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "@/components/GraphView";
import { LocalGraphModal } from "@/components/LocalGraphModal";
import { MemoryView } from "@/components/MemoryView";
import { Overview } from "@/components/Overview";
import { SearchResults } from "@/components/SearchResults";
import { Sidebar } from "@/components/Sidebar";
import {
  createWorkspace,
  forgetMemory,
  getMemory,
  listAllMemories,
  listWorkspaces,
  memoryTitle,
  memoryType,
  readGraph,
  rememberMemory,
  searchMemories,
  updateMemory,
} from "@/lib/lore-api";
import { parseRoute, type RouteState, routeUrl, type Tab } from "@/lib/route";
import type {
  GraphData,
  Memory,
  MemoryScope,
  MemorySearchResult,
  WorkspaceSummary,
} from "@/lib/types";

const TAB_LABELS: Record<Tab, string> = {
  overview: "Dashboard",
  graph: "Graph",
  search: "Memories",
};

interface GraphStore {
  nodes: GraphData["nodes"];
  links: GraphData["links"];
  byId: Record<string, GraphData["nodes"][number]>;
  adj: Record<string, Set<string>>;
}

interface MemoryLink {
  id: string;
  label: string;
}

interface MemoryDetailState {
  memory: Memory;
  title: string;
  type: string;
  id: string;
  body: string;
  related: MemoryLink[];
}

interface AppProps {
  appTitle: string;
  appSubtitle: string;
}

interface EditorState {
  mode: "create" | "edit";
  memory?: Memory;
}

function buildGraph(data: GraphData): GraphStore {
  const byId: GraphStore["byId"] = {};
  const adj: GraphStore["adj"] = {};
  for (const node of data.nodes) {
    byId[node.id] = node;
    adj[node.id] = new Set([node.id]);
  }
  for (const link of data.links) {
    if (!adj[link.source]) adj[link.source] = new Set();
    if (!adj[link.target]) adj[link.target] = new Set();
    adj[link.source].add(link.target);
    adj[link.target].add(link.source);
  }
  return { nodes: data.nodes, links: data.links, byId, adj };
}

function graphNeighbors(graph: GraphStore | null, id: string): MemoryLink[] {
  if (!graph?.adj[id]) return [];
  return [...graph.adj[id]]
    .filter((neighborId) => neighborId !== id)
    .map((neighborId) => ({
      id: neighborId,
      label: graph.byId[neighborId]?.label ?? neighborId,
    }));
}

function sameLinks(left: MemoryLink[], right: MemoryLink[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (link, index) => link.id === right[index]?.id && link.label === right[index]?.label,
  );
}

function memoryDetailState(memory: Memory, graph: GraphStore | null): MemoryDetailState {
  return {
    memory,
    title: memoryTitle(memory),
    type: memoryType(memory),
    id: memory.id,
    body: memory.content,
    related: graphNeighbors(graph, memory.id),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function App({ appTitle, appSubtitle }: AppProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("overview");
  const [graph, setGraph] = useState<GraphStore | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphLoaded, setGraphLoaded] = useState(false);
  const [graphRevision, setGraphRevision] = useState(0);
  const [graphFocus, setGraphFocus] = useState<string | undefined>();
  const [localGraphId, setLocalGraphId] = useState<string | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<MemoryDetailState | null>(null);
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesLoaded, setMemoriesLoaded] = useState(false);
  const [memoryTypeFilter, setMemoryTypeFilter] = useState("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const graphRef = useRef<GraphStore | null>(null);
  const graphEverVisible = useRef(false);
  const applyingRouteRef = useRef(false);
  const detailRequest = useRef(0);
  const searchRequest = useRef(0);
  graphRef.current = graph;

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  useEffect(() => {
    const controller = new AbortController();
    void listWorkspaces(controller.signal)
      .then((loaded) => {
        setWorkspaces(loaded);
        const remembered = window.localStorage.getItem("lore.workspace");
        const next = loaded.find((workspace) => workspace.id === remembered)?.id ?? loaded[0]?.id;
        setActiveWorkspaceId(next ?? "");
        setWorkspaceError(null);
      })
      .catch((cause) => {
        if ((cause as Error).name !== "AbortError") setWorkspaceError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorkspacesLoaded(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (activeWorkspaceId) {
      window.localStorage.setItem("lore.workspace", activeWorkspaceId);
    }
    detailRequest.current += 1;
    searchRequest.current += 1;
    setSelectedMemory(null);
    setLocalGraphId(null);
    setGraphFocus(undefined);
    setSearchResults([]);
    setSearchQuery("");
    setMemoryTypeFilter("all");
    setMemories([]);
    setMemoriesLoaded(false);
    setGraph(null);
    setGraphData({ nodes: [], links: [] });
    setGraphLoaded(false);
    setGraphError(null);
    if (searchRef.current) searchRef.current.value = "";
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const controller = new AbortController();
    setMemoriesLoaded(false);
    void listAllMemories(activeWorkspaceId, controller.signal)
      .then((loadedMemories) => setMemories(loadedMemories))
      .catch((cause) => {
        if ((cause as Error).name !== "AbortError") setWorkspaceError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setMemoriesLoaded(true);
      });
    return () => controller.abort();
  }, [activeWorkspaceId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: graphRevision explicitly invalidates the derived graph after a Memory mutation.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const controller = new AbortController();
    setGraphLoaded(false);
    setGraphError(null);
    void readGraph(activeWorkspaceId, controller.signal)
      .then((data) => {
        const store = buildGraph(data);
        setGraph(store);
        setGraphData(data);
      })
      .catch((cause) => {
        if ((cause as Error).name !== "AbortError") setGraphError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setGraphLoaded(true);
      });
    return () => controller.abort();
  }, [activeWorkspaceId, graphRevision]);

  useEffect(() => {
    if (!graph || !selectedMemory) return;
    setSelectedMemory((current) => {
      if (!current) return current;
      const related = graphNeighbors(graph, current.id);
      return sameLinks(current.related, related) ? current : { ...current, related };
    });
  }, [graph, selectedMemory]);

  const resolveMemory = useCallback(
    async (id: string, currentGraph: GraphStore | null) => {
      if (!activeWorkspaceId) return;
      const request = ++detailRequest.current;
      try {
        const memory = await getMemory(activeWorkspaceId, id);
        if (detailRequest.current !== request) return;
        setSelectedMemory(memoryDetailState(memory, currentGraph ?? graphRef.current));
        window.scrollTo(0, 0);
      } catch (cause) {
        if (detailRequest.current !== request) return;
        setMutationError(errorMessage(cause));
      }
    },
    [activeWorkspaceId],
  );

  const runSearch = useCallback(
    async (query: string) => {
      if (!activeWorkspaceId) return;
      const request = ++searchRequest.current;
      try {
        const items = await searchMemories(activeWorkspaceId, query, 25);
        if (searchRequest.current === request) setSearchResults(items);
      } catch {
        if (searchRequest.current === request) setSearchResults([]);
      }
    },
    [activeWorkspaceId],
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
    const type = route.type ?? memoryTypeFilter;
    return {
      tab: route.tab,
      q: route.tab === "search" ? query || undefined : undefined,
      type: route.tab === "search" && !query ? type : undefined,
      focusId: route.tab === "graph" ? route.focusId : undefined,
    };
  }, [memoryTypeFilter, searchQuery]);

  const openMemory = useCallback(
    (id: string) => {
      if (!id) return;
      writeRoute({ ...currentBaseRoute(), memoryId: id });
      void resolveMemory(id, graphRef.current);
    },
    [currentBaseRoute, resolveMemory, writeRoute],
  );

  const applyRoute = useCallback(
    (route: RouteState) => {
      applyingRouteRef.current = true;
      detailRequest.current += 1;
      setSelectedMemory(null);
      setLocalGraphId(null);
      setTab(route.tab);
      setGraphFocus(route.tab === "graph" ? route.focusId : undefined);

      const query = (route.q ?? "").trim();
      const type = route.type ?? "all";
      setSearchQuery(query);
      setMemoryTypeFilter(type);
      if (searchRef.current) searchRef.current.value = query;
      if (query) void runSearch(query);
      else setSearchResults([]);
      if (route.memoryId) void resolveMemory(route.memoryId, graphRef.current);
      else window.scrollTo(0, 0);

      window.setTimeout(() => {
        applyingRouteRef.current = false;
      }, 0);
    },
    [resolveMemory, runSearch],
  );

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const initial = parseRoute(window.location.pathname, window.location.search);
    window.history.replaceState(initial, "", routeUrl(initial));
    applyRoute(initial);
    const onPopState = () =>
      applyRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activeWorkspaceId, applyRoute]);

  function handleSearch(value: string) {
    const query = value.trim();
    if (searchRef.current && searchRef.current.value !== value) searchRef.current.value = value;
    setLocalGraphId(null);
    setSearchQuery(query);
    if (!query) {
      searchRequest.current += 1;
      setSearchResults([]);
      if (tab === "search" && !selectedMemory) {
        writeRoute({ tab: "search", type: memoryTypeFilter }, "replace");
      }
      return;
    }
    detailRequest.current += 1;
    setSelectedMemory(null);
    setTab("search");
    writeRoute(
      { tab: "search", q: query },
      tab === "search" && !selectedMemory ? "replace" : "push",
    );
    void runSearch(query);
  }

  function handleTabChange(nextTab: Tab) {
    detailRequest.current += 1;
    setSelectedMemory(null);
    setLocalGraphId(null);
    setGraphFocus(undefined);
    if (nextTab === "search") {
      searchRequest.current += 1;
      setSearchQuery("");
      setSearchResults([]);
      setMemoryTypeFilter("all");
      if (searchRef.current) searchRef.current.value = "";
    }
    setTab(nextTab);
    writeRoute({ tab: nextTab });
  }

  function drillType(type: string) {
    detailRequest.current += 1;
    setSelectedMemory(null);
    setLocalGraphId(null);
    setSearchQuery("");
    setSearchResults([]);
    setMemoryTypeFilter(type);
    setTab("search");
    if (searchRef.current) searchRef.current.value = "";
    writeRoute({ tab: "search", type });
  }

  async function saveEditor(content: string, scope: MemoryScope) {
    if (!activeWorkspaceId || !editor) return;
    setSaving(true);
    setMutationError(null);
    try {
      const saved = editor.memory
        ? await updateMemory(activeWorkspaceId, editor.memory.id, { content, scope })
        : await rememberMemory(activeWorkspaceId, { content, scope });
      setMemories((current) => [saved, ...current.filter((memory) => memory.id !== saved.id)]);
      setSearchResults((current) =>
        current.map((result) =>
          result.memory.id === saved.id ? { ...result, memory: saved } : result,
        ),
      );
      setEditor(null);
      setSelectedMemory(memoryDetailState(saved, graphRef.current));
      setTab("search");
      writeRoute({ tab: "search", memoryId: saved.id });
      setGraphRevision((revision) => revision + 1);
    } catch (cause) {
      setMutationError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function removeOpenMemory() {
    if (!activeWorkspaceId || !selectedMemory) return;
    if (!window.confirm("Forget this Memory? This cannot be undone.")) return;
    setSaving(true);
    setMutationError(null);
    try {
      await forgetMemory(activeWorkspaceId, selectedMemory.id);
      setMemories((current) => current.filter((memory) => memory.id !== selectedMemory.id));
      setSearchResults((current) =>
        current.filter((result) => result.memory.id !== selectedMemory.id),
      );
      setSelectedMemory(null);
      writeRoute({ tab }, "replace");
      setGraphRevision((revision) => revision + 1);
    } catch (cause) {
      setMutationError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function addWorkspace(name: string) {
    setSaving(true);
    setMutationError(null);
    try {
      const created = await createWorkspace(name);
      setWorkspaces((current) => [...current, created]);
      setActiveWorkspaceId(created.id);
      setWorkspaceDialogOpen(false);
      setWorkspaceError(null);
      writeRoute({ tab: "overview" }, "replace");
    } catch (cause) {
      setMutationError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!workspacesLoaded) {
    return <main className="app-loading">Opening Lore…</main>;
  }

  if (!workspaces.length) {
    return (
      <WorkspaceOnboarding
        appTitle={appTitle}
        error={mutationError ?? workspaceError}
        saving={saving}
        onCreate={addWorkspace}
      />
    );
  }

  const graphReady = graphLoaded && !graphError && graphData.nodes.length > 0;
  const graphVisible = tab === "graph" && !selectedMemory && graphReady;
  if (graphVisible) graphEverVisible.current = true;

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={tab}
        activeWorkspaceId={activeWorkspaceId}
        workspaces={workspaces}
        onWorkspaceChange={(workspaceId) => {
          setTab("overview");
          setActiveWorkspaceId(workspaceId);
          writeRoute({ tab: "overview" });
        }}
        onCreateWorkspace={() => {
          setMutationError(null);
          setWorkspaceDialogOpen(true);
        }}
        onNewMemory={() => {
          setMutationError(null);
          setEditor({ mode: "create" });
        }}
        onTabChange={handleTabChange}
        onSearch={handleSearch}
        searchRef={searchRef}
      />

      <main className="app-main">
        {workspaceError && (
          <div className="native-error" role="alert">
            <span>{workspaceError}</span>
            <button type="button" onClick={() => setWorkspaceError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {graphEverVisible.current && graphReady && (
          <div className="view-anim" style={graphVisible ? undefined : { display: "none" }}>
            <GraphView
              key={activeWorkspaceId}
              workspaceId={activeWorkspaceId}
              data={graphData}
              focusId={graphFocus}
              onOpen={openMemory}
              onResetFilter={() => {
                setGraphFocus(undefined);
                writeRoute({ tab: "graph" }, "replace");
              }}
            />
          </div>
        )}

        {!graphVisible && (
          <div
            className="view-anim"
            key={selectedMemory ? `memory:${selectedMemory.id}` : `tab:${tab}`}
          >
            {selectedMemory ? (
              <MemoryView
                title={selectedMemory.title}
                type={selectedMemory.type}
                id={selectedMemory.id}
                body={selectedMemory.body}
                scope={selectedMemory.memory.scope}
                ownerUserId={selectedMemory.memory.ownerUserId}
                createdByAgentId={selectedMemory.memory.createdByAgentId}
                createdAt={selectedMemory.memory.createdAt}
                updatedAt={selectedMemory.memory.updatedAt}
                version={selectedMemory.memory.version}
                related={selectedMemory.related}
                backLabel={TAB_LABELS[tab]}
                saving={saving}
                error={mutationError}
                onBack={() => {
                  detailRequest.current += 1;
                  setSelectedMemory(null);
                  setLocalGraphId(null);
                  setMutationError(null);
                  writeRoute(currentBaseRoute(), "replace");
                }}
                onOpen={openMemory}
                onLocalGraph={setLocalGraphId}
                onEdit={() => {
                  setMutationError(null);
                  setEditor({ mode: "edit", memory: selectedMemory.memory });
                }}
                onForget={() => void removeOpenMemory()}
              />
            ) : (
              <>
                {tab === "overview" && (
                  <Overview
                    appTitle={appTitle}
                    appSubtitle={appSubtitle}
                    workspaceName={activeWorkspace?.name ?? "Workspace"}
                    graphData={graphData}
                    graphError={graphError}
                    memories={memories}
                    onOpen={openMemory}
                    onType={drillType}
                    onNavigate={handleTabChange}
                  />
                )}

                {tab === "graph" &&
                  (!graphLoaded ? (
                    <div className="view-placeholder">Loading graph…</div>
                  ) : graphError ? (
                    <div className="view-placeholder">
                      Couldn&apos;t load the Workspace graph — {graphError}.
                    </div>
                  ) : graphData.nodes.length === 0 ? (
                    <div className="view-placeholder">
                      No visible Memories to graph yet. Capture a few related facts and Lore will
                      derive affinity links inside this Workspace.
                    </div>
                  ) : null)}

                {tab === "search" && (
                  <SearchResults
                    results={searchResults}
                    memories={memories}
                    loading={!memoriesLoaded}
                    query={searchQuery}
                    typeFilter={memoryTypeFilter}
                    onTypeFilter={setMemoryTypeFilter}
                    onOpen={openMemory}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>

      {localGraphId && graphData.nodes.length > 0 && (
        <LocalGraphModal
          workspaceId={activeWorkspaceId}
          data={graphData}
          focusId={localGraphId}
          title={graph?.byId[localGraphId]?.label ?? "Memory"}
          onClose={() => setLocalGraphId(null)}
          onOpen={openMemory}
          onOpenGraph={(id) => {
            setLocalGraphId(null);
            setSelectedMemory(null);
            setTab("graph");
            setGraphFocus(id);
            writeRoute({ tab: "graph", focusId: id });
          }}
        />
      )}

      {editor && (
        <MemoryEditor
          key={`${editor.mode}:${editor.memory?.id ?? "new"}`}
          memory={editor.memory}
          saving={saving}
          error={mutationError}
          onClose={() => {
            setEditor(null);
            setMutationError(null);
          }}
          onSave={saveEditor}
        />
      )}

      {workspaceDialogOpen && (
        <WorkspaceDialog
          saving={saving}
          error={mutationError}
          onClose={() => {
            setWorkspaceDialogOpen(false);
            setMutationError(null);
          }}
          onCreate={addWorkspace}
        />
      )}
    </div>
  );
}

function MemoryEditor({
  memory,
  saving,
  error,
  onClose,
  onSave,
}: {
  memory?: Memory;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (content: string, scope: MemoryScope) => Promise<void>;
}) {
  const [content, setContent] = useState(memory?.content ?? "");
  const [scope, setScope] = useState<MemoryScope>(memory?.scope ?? "shared");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  return (
    <div className="memory-editor-backdrop">
      <button
        type="button"
        className="memory-editor-scrim"
        aria-label="Close Memory editor"
        onClick={() => !saving && onClose()}
      />
      <dialog
        open
        className="memory-editor"
        aria-modal="true"
        aria-labelledby="memory-editor-title"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (content.trim()) void onSave(content.trim(), scope);
          }}
        >
          <header className="memory-editor-header">
            <div>
              <p className="memory-editor-kicker">{memory ? "Memory" : "Capture"}</p>
              <h2 id="memory-editor-title">{memory ? "Edit memory" : "New memory"}</h2>
            </div>
            <button
              type="button"
              className="memory-editor-close"
              onClick={onClose}
              disabled={saving}
            >
              Close
            </button>
          </header>
          <label htmlFor="memory-editor-content">Content</label>
          <textarea
            ref={textareaRef}
            id="memory-editor-content"
            value={content}
            rows={12}
            maxLength={1_000_000}
            placeholder="Write a durable fact, decision, preference, or piece of context…"
            onChange={(event) => setContent(event.target.value)}
          />
          <fieldset className="memory-scope-control">
            <legend>Visibility</legend>
            {(["shared", "private"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
              >
                {value}
              </button>
            ))}
          </fieldset>
          {error && <p className="memory-editor-error">{error}</p>}
          <footer className="memory-editor-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="memory-editor-primary"
              disabled={saving || !content.trim()}
            >
              {saving ? "Saving…" : memory ? "Save changes" : "Remember"}
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

function WorkspaceDialog({
  saving,
  error,
  onClose,
  onCreate,
}: {
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <div className="memory-editor-backdrop">
      <button
        type="button"
        className="memory-editor-scrim"
        aria-label="Close Workspace creator"
        onClick={() => !saving && onClose()}
      />
      <dialog
        open
        className="workspace-dialog"
        aria-modal="true"
        aria-labelledby="workspace-dialog-title"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void onCreate(name.trim());
          }}
        >
          <p className="memory-editor-kicker">Memory boundary</p>
          <h2 id="workspace-dialog-title">New workspace</h2>
          <label htmlFor="workspace-dialog-name">Workspace name</label>
          <input
            id="workspace-dialog-name"
            value={name}
            maxLength={120}
            placeholder="Acme Research"
            onChange={(event) => setName(event.target.value)}
          />
          {error && <p className="memory-editor-error">{error}</p>}
          <footer className="memory-editor-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              className="memory-editor-primary"
              disabled={saving || !name.trim()}
            >
              {saving ? "Creating…" : "Create workspace"}
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

function WorkspaceOnboarding({
  appTitle,
  saving,
  error,
  onCreate,
}: {
  appTitle: string;
  saving: boolean;
  error: string | null;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <main className="workspace-onboarding">
      <section className="workspace-onboarding-hero">
        <div className="hero-mesh" />
        <p className="hero-eyebrow">Lore · {appTitle}</p>
        <h1>Create a Workspace.</h1>
        <p>Workspaces contain members, permitted Agents, and the Memories they can see.</p>
      </section>
      <form
        className="workspace-onboarding-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void onCreate(name.trim());
        }}
      >
        <label htmlFor="first-workspace-name">Workspace name</label>
        <input
          id="first-workspace-name"
          value={name}
          maxLength={120}
          placeholder="Acme Research"
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p className="memory-editor-error">{error}</p>}
        <button type="submit" className="memory-editor-primary" disabled={saving || !name.trim()}>
          {saving ? "Creating…" : "Create workspace"}
        </button>
      </form>
    </main>
  );
}
