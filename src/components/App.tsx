"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GraphView } from "@/components/GraphView";
import { LocalGraphModal } from "@/components/LocalGraphModal";
import { MemoryView } from "@/components/MemoryView";
import { Overview } from "@/components/Overview";
import { SearchResults } from "@/components/SearchResults";
import { Sidebar } from "@/components/Sidebar";
import { memoryTitle, memoryType } from "@/lib/lore-api";
import {
  loreKeys,
  removeMemoryFromPages,
  upsertMemoryPages,
  useLoreGraph,
  useLoreMemories,
  useLoreMemory,
  useLoreMutations,
  useLoreSearch,
  useLoreWorkspaces,
} from "@/lib/lore-swr";
import { parseRoute, type RouteState, routeUrl, type Tab } from "@/lib/route";
import type { GraphData, Memory, MemoryScope } from "@/lib/types";

const TAB_LABELS: Record<Tab, string> = {
  overview: "Dashboard",
  graph: "Graph",
  search: "Memories",
};

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

interface GraphStore {
  nodes: GraphData["nodes"];
  links: GraphData["links"];
  byId: Record<string, GraphData["nodes"][number]>;
  byReference: Record<string, string>;
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
  const byReference = Object.create(null) as GraphStore["byReference"];
  const ambiguousReferences = new Set<string>();
  const adj: GraphStore["adj"] = {};
  for (const node of data.nodes) {
    byId[node.id] = node;
    adj[node.id] = new Set([node.id]);
    for (const reference of new Set([node.id, node.reference])) {
      if (!reference || ambiguousReferences.has(reference)) continue;
      const existing = byReference[reference];
      if (existing && existing !== node.id) {
        delete byReference[reference];
        ambiguousReferences.add(reference);
      } else {
        byReference[reference] = node.id;
      }
    }
  }
  for (const link of data.links) {
    if (!adj[link.source]) adj[link.source] = new Set();
    if (!adj[link.target]) adj[link.target] = new Set();
    adj[link.source].add(link.target);
    adj[link.target].add(link.source);
  }
  return { nodes: data.nodes, links: data.links, byId, byReference, adj };
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
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [graphFocus, setGraphFocus] = useState<string | undefined>();
  const [localGraphId, setLocalGraphId] = useState<string | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [memoryTypeFilter, setMemoryTypeFilter] = useState("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [dismissedWorkspaceError, setDismissedWorkspaceError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const graphEverVisible = useRef(false);
  const applyingRouteRef = useRef(false);

  const {
    data: workspaces = [],
    error: workspacesRequestError,
    isLoading: workspacesLoading,
    mutate: mutateWorkspaces,
  } = useLoreWorkspaces();
  const {
    memories,
    error: memoriesRequestError,
    isCapped: memoriesCapped,
    isLoading: memoriesLoading,
    mutate: mutateMemories,
  } = useLoreMemories(activeWorkspaceId);
  const {
    data: graphData = EMPTY_GRAPH,
    error: graphRequestError,
    isLoading: graphLoading,
    mutate: mutateGraph,
  } = useLoreGraph(activeWorkspaceId);
  const {
    data: searchResults = [],
    error: searchRequestError,
    isLoading: searchLoading,
    mutate: mutateSearch,
  } = useLoreSearch(activeWorkspaceId, searchQuery, 25);
  const { data: selectedMemoryData, error: selectedMemoryRequestError } = useLoreMemory(
    activeWorkspaceId,
    selectedMemoryId,
  );
  const mutations = useLoreMutations(activeWorkspaceId);
  const saving = mutations.isMutating;
  const graph = useMemo(() => buildGraph(graphData), [graphData]);
  const selectedMemory = useMemo(
    () => (selectedMemoryData ? memoryDetailState(selectedMemoryData, graph) : null),
    [graph, selectedMemoryData],
  );
  const graphError = graphRequestError ? errorMessage(graphRequestError) : null;
  const graphLoaded = !activeWorkspaceId || !graphLoading;
  const workspaceRequestError = workspacesRequestError ?? memoriesRequestError;
  const workspaceErrorMessage = workspaceRequestError ? errorMessage(workspaceRequestError) : null;
  const workspaceError =
    workspaceErrorMessage === dismissedWorkspaceError ? null : workspaceErrorMessage;

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (!workspaces.length) {
      if (activeWorkspaceId) setActiveWorkspaceId("");
      return;
    }
    if (workspaces.some((workspace) => workspace.id === activeWorkspaceId)) return;
    const remembered = window.localStorage.getItem("lore.workspace");
    const next =
      workspaces.find((workspace) => workspace.id === remembered)?.id ?? workspaces[0]?.id;
    setActiveWorkspaceId(next ?? "");
  }, [activeWorkspaceId, workspaces]);

  useEffect(() => {
    if (activeWorkspaceId) {
      window.localStorage.setItem("lore.workspace", activeWorkspaceId);
    }
    setSelectedMemoryId(null);
    setLocalGraphId(null);
    setGraphFocus(undefined);
    setSearchQuery("");
    setMemoryTypeFilter("all");
    setMutationError(null);
    if (searchRef.current) searchRef.current.value = "";
  }, [activeWorkspaceId]);

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
      setSelectedMemoryId(id);
      setMutationError(null);
      window.scrollTo(0, 0);
    },
    [currentBaseRoute, writeRoute],
  );

  const applyRoute = useCallback((route: RouteState) => {
    applyingRouteRef.current = true;
    setSelectedMemoryId(route.memoryId ?? null);
    setLocalGraphId(null);
    setTab(route.tab);
    setGraphFocus(route.tab === "graph" ? route.focusId : undefined);

    const query = (route.q ?? "").trim();
    const type = route.type ?? "all";
    setSearchQuery(query);
    setMemoryTypeFilter(type);
    if (searchRef.current) searchRef.current.value = query;
    window.scrollTo(0, 0);

    window.setTimeout(() => {
      applyingRouteRef.current = false;
    }, 0);
  }, []);

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
      if (tab === "search" && !selectedMemoryId) {
        writeRoute({ tab: "search", type: memoryTypeFilter }, "replace");
      }
      return;
    }
    setSelectedMemoryId(null);
    setTab("search");
    writeRoute(
      { tab: "search", q: query },
      tab === "search" && !selectedMemoryId ? "replace" : "push",
    );
  }

  function handleTabChange(nextTab: Tab) {
    setSelectedMemoryId(null);
    setLocalGraphId(null);
    setGraphFocus(undefined);
    if (nextTab === "search") {
      setSearchQuery("");
      setMemoryTypeFilter("all");
      if (searchRef.current) searchRef.current.value = "";
    }
    setTab(nextTab);
    writeRoute({ tab: nextTab });
  }

  function drillType(type: string) {
    setSelectedMemoryId(null);
    setLocalGraphId(null);
    setSearchQuery("");
    setMemoryTypeFilter(type);
    setTab("search");
    if (searchRef.current) searchRef.current.value = "";
    writeRoute({ tab: "search", type });
  }

  async function saveEditor(content: string, scope: MemoryScope) {
    if (!activeWorkspaceId || !editor) return;
    setMutationError(null);
    try {
      const saved = await mutations.saveMemory.trigger({
        id: editor.memory?.id,
        content,
        scope,
      });
      await mutations.mutateCache(loreKeys.memory(activeWorkspaceId, saved.id), saved, {
        revalidate: false,
      });
      await mutateMemories((pages) => upsertMemoryPages(pages, saved), { revalidate: true });
      if (searchQuery) void mutateSearch();
      void mutateGraph();
      setEditor(null);
      setSelectedMemoryId(saved.id);
      setTab("search");
      writeRoute({ tab: "search", memoryId: saved.id });
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  async function removeOpenMemory() {
    if (!activeWorkspaceId || !selectedMemory) return;
    if (!window.confirm("Forget this Memory? This cannot be undone.")) return;
    setMutationError(null);
    const memoryId = selectedMemory.id;
    try {
      await mutations.forgetMemory.trigger(memoryId);
      await mutations.mutateCache(loreKeys.memory(activeWorkspaceId, memoryId), undefined, {
        revalidate: false,
      });
      await mutateMemories((pages) => removeMemoryFromPages(pages, memoryId), {
        revalidate: true,
      });
      if (searchQuery) void mutateSearch();
      void mutateGraph();
      setSelectedMemoryId(null);
      writeRoute({ tab }, "replace");
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  async function addWorkspace(name: string) {
    setMutationError(null);
    try {
      const created = await mutations.createWorkspace.trigger(name);
      await mutateWorkspaces((current = []) => [...current, created], { revalidate: false });
      setActiveWorkspaceId(created.id);
      setWorkspaceDialogOpen(false);
      writeRoute({ tab: "overview" }, "replace");
    } catch (cause) {
      setMutationError(errorMessage(cause));
    }
  }

  if (workspacesLoading || (workspaces.length > 0 && !activeWorkspaceId)) {
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
  const graphVisible = tab === "graph" && !selectedMemoryId && graphReady;
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
            <button type="button" onClick={() => setDismissedWorkspaceError(workspaceError)}>
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
            key={selectedMemoryId ? `memory:${selectedMemoryId}` : `tab:${tab}`}
          >
            {selectedMemory ? (
              <MemoryView
                title={selectedMemory.title}
                type={selectedMemory.type}
                id={selectedMemory.id}
                body={selectedMemory.body}
                wikilinkTargets={graph?.byReference ?? {}}
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
                  setSelectedMemoryId(null);
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
            ) : selectedMemoryId ? (
              <div className="page-wrap">
                <button
                  type="button"
                  className="back-link"
                  onClick={() => {
                    setSelectedMemoryId(null);
                    writeRoute(currentBaseRoute(), "replace");
                  }}
                >
                  ← {TAB_LABELS[tab]}
                </button>
                <div className="view-placeholder">
                  {selectedMemoryRequestError
                    ? `Couldn't load this Memory — ${errorMessage(selectedMemoryRequestError)}.`
                    : "Loading Memory…"}
                </div>
              </div>
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
                      find Memory Links or derive affinities inside this Workspace.
                    </div>
                  ) : null)}

                {tab === "search" && (
                  <SearchResults
                    results={searchResults}
                    memories={memories}
                    capped={memoriesCapped}
                    loading={searchQuery ? searchLoading : memoriesLoading}
                    error={searchRequestError ? errorMessage(searchRequestError) : null}
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
            setSelectedMemoryId(null);
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
