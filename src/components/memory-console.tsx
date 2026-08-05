"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoreSidebar, type LoreView, type WorkspaceOption } from "./lore-sidebar";
import { MemoryGraphView } from "./memory-graph";
import { Button } from "./ui/button";
import { ArrowLeftIcon, CloseIcon, PlusIcon } from "./ui/icons";

interface MemoryConsoleProps {
  appTitle: string;
  appSubtitle: string;
}

interface Memory {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  createdByAgentId: string | null;
  scope: "shared" | "private";
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface SearchResult {
  memory: Memory;
  score: number;
  evidence: string;
}

async function requestJson<Result>(
  path: string,
  init: RequestInit = {},
  workspaceId?: string,
): Promise<Result> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (workspaceId) headers.set("x-lore-workspace-id", workspaceId);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as Result;
  return response.json() as Promise<Result>;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function displayDate(value: string): string {
  return DATE_FORMAT.format(new Date(value));
}

function memoryPreview(content: string, limit = 220): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1).trimEnd()}…` : compact;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MemoryConsole({ appTitle, appSubtitle }: MemoryConsoleProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchEvidence, setSearchEvidence] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [activeView, setActiveView] = useState<LoreView>("memories");
  const [detailOrigin, setDetailOrigin] = useState<LoreView>("memories");
  const [loading, setLoading] = useState(true);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftScope, setDraftScope] = useState<Memory["scope"]>("shared");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editScope, setEditScope] = useState<Memory["scope"]>("shared");
  const newMemoryButtonRef = useRef<HTMLButtonElement>(null);
  const composerDialogRef = useRef<HTMLDialogElement>(null);
  const workspaceDialogRef = useRef<HTMLDialogElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const workspaceNameRef = useRef<HTMLInputElement>(null);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await requestJson<WorkspaceOption[]>("/api/workspaces");
      setWorkspaces(loaded);
      const stored = window.localStorage.getItem("lore.workspace");
      const next = loaded.find((workspace) => workspace.id === stored)?.id ?? loaded[0]?.id ?? "";
      setActiveWorkspaceId(next);
      setActiveView("memories");
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (activeWorkspaceId) window.localStorage.setItem("lore.workspace", activeWorkspaceId);
    setSelected(null);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setMemories([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(
      async () => {
        setResultsLoading(true);
        try {
          const path = query.trim()
            ? `/api/memories?q=${encodeURIComponent(query.trim())}&limit=50`
            : "/api/memories?limit=50";
          const loaded = await requestJson<Memory[] | SearchResult[]>(
            path,
            { signal: controller.signal },
            activeWorkspaceId,
          );
          if (query.trim()) {
            const results = loaded as SearchResult[];
            setMemories(results.map((result) => result.memory));
            setSearchEvidence(
              Object.fromEntries(results.map((result) => [result.memory.id, result.evidence])),
            );
          } else {
            setMemories(loaded as Memory[]);
            setSearchEvidence({});
          }
          setError(null);
        } catch (cause) {
          if ((cause as Error).name !== "AbortError") setError(errorMessage(cause));
        } finally {
          if (!controller.signal.aborted) setResultsLoading(false);
        }
      },
      query ? 220 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeWorkspaceId, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditing = target?.matches("input, textarea, select, [contenteditable=true]");
      if (event.key === "/" && !isEditing && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#memory-search")?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!composerOpen) return;
    const dialog = composerDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    draftRef.current?.focus();
  }, [composerOpen]);

  useEffect(() => {
    if (!creatingWorkspace) return;
    const dialog = workspaceDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    workspaceNameRef.current?.focus();
  }, [creatingWorkspace]);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceName.trim()) return;
    setSaving(true);
    try {
      const workspace = await requestJson<WorkspaceOption>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: workspaceName }),
      });
      setWorkspaces((current) => [...current, { ...workspace, role: "owner" }]);
      setActiveWorkspaceId(workspace.id);
      setWorkspaceName("");
      setCreatingWorkspace(false);
      setQuery("");
      setActiveView("memories");
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function createMemory(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim() || !activeWorkspaceId) return;
    setSaving(true);
    try {
      const memory = await requestJson<Memory>(
        "/api/memories",
        { method: "POST", body: JSON.stringify({ content: draft, scope: draftScope }) },
        activeWorkspaceId,
      );
      setMemories((current) => [memory, ...current]);
      setDraft("");
      setDraftScope("shared");
      setComposerOpen(false);
      setQuery("");
      setError(null);
      newMemoryButtonRef.current?.focus();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function openMemory(memory: Memory, origin: LoreView = activeView) {
    setDetailOrigin(origin);
    setSelected(memory);
    setEditContent(memory.content);
    setEditScope(memory.scope);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function openMemoryById(memoryId: string) {
    const memory = await requestJson<Memory>(`/api/memories/${memoryId}`, {}, activeWorkspaceId);
    openMemory(memory, "graph");
  }

  async function updateMemory(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !editContent.trim()) return;
    setSaving(true);
    try {
      const updated = await requestJson<Memory>(
        `/api/memories/${selected.id}`,
        { method: "PATCH", body: JSON.stringify({ content: editContent, scope: editScope }) },
        activeWorkspaceId,
      );
      setMemories((current) =>
        current.map((memory) => (memory.id === updated.id ? updated : memory)),
      );
      setSelected(updated);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function forgetMemory() {
    if (!selected || !window.confirm("Forget this Memory? This cannot be undone.")) return;
    setSaving(true);
    try {
      await requestJson<void>(
        `/api/memories/${selected.id}`,
        { method: "DELETE" },
        activeWorkspaceId,
      );
      setMemories((current) => current.filter((memory) => memory.id !== selected.id));
      setSelected(null);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function closeComposer() {
    setComposerOpen(false);
    window.setTimeout(() => newMemoryButtonRef.current?.focus(), 0);
  }

  function closeWorkspaceCreator() {
    setCreatingWorkspace(false);
    setWorkspaceName("");
    window.setTimeout(
      () => document.querySelector<HTMLButtonElement>(".sidebar-create")?.focus(),
      0,
    );
  }

  if (loading) {
    return (
      <main className="app-loading" aria-live="polite">
        <Image src="/lore-mark.svg" alt="" width={30} height={30} priority />
        <span>Opening Lore…</span>
      </main>
    );
  }

  if (!workspaces.length) {
    return (
      <main className="onboarding-shell">
        <section className="onboarding-hero">
          <div className="hero-mesh" aria-hidden="true" />
          <a className="wordmark onboarding-wordmark" href="/" aria-label="Lore home">
            <Image src="/lore-mark.svg" alt="" width={24} height={24} priority />
            <span className="wordmark-title">Lore</span>
          </a>
          <div className="onboarding-copy">
            <p className="page-eyebrow">Your first memory boundary</p>
            <h1>Create a Workspace.</h1>
            <p className="onboarding-description">
              A Workspace contains members, permitted Agents, and the Memories they are allowed to
              see. It is Lore&apos;s only tenant boundary.
            </p>
          </div>
        </section>
        <form className="onboarding-form" onSubmit={createWorkspace}>
          <div>
            <p className="page-eyebrow">Get started</p>
            <h2>Name this Workspace</h2>
          </div>
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            id="workspace-name"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="Acme Research"
            maxLength={120}
          />
          <Button variant="primary" type="submit" disabled={saving || !workspaceName.trim()}>
            {saving ? "Creating…" : "Create Workspace"}
          </Button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <LoreSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        query={query}
        activeView={activeView}
        onWorkspaceChange={(workspaceId) => {
          setActiveWorkspaceId(workspaceId);
          setQuery("");
          setActiveView("memories");
        }}
        onQueryChange={(nextQuery) => {
          setQuery(nextQuery);
          setSelected(null);
          setActiveView("memories");
        }}
        onCreateWorkspace={() => setCreatingWorkspace(true)}
        onNavigate={(view) => {
          setActiveView(view);
          setSelected(null);
          if (view === "graph") setQuery("");
        }}
      />

      <main className="app-main">
        {selected ? (
          <MemoryDetail
            memory={selected}
            content={editContent}
            scope={editScope}
            saving={saving}
            error={error}
            onBack={() => setSelected(null)}
            backLabel={detailOrigin === "graph" ? "Graph" : "Memories"}
            onContentChange={setEditContent}
            onScopeChange={setEditScope}
            onSubmit={updateMemory}
            onForget={forgetMemory}
            onDismissError={() => setError(null)}
          />
        ) : activeView === "graph" && activeWorkspace ? (
          <MemoryGraphView
            workspaceId={activeWorkspaceId}
            workspaceName={activeWorkspace.name}
            appTitle={appTitle}
            onOpenMemory={openMemoryById}
          />
        ) : (
          <section className="page-wrap view-anim" aria-labelledby="memories-title">
            <header className="page-header">
              <div>
                <p className="page-eyebrow">
                  {activeWorkspace?.name} · {appTitle}
                </p>
                <h1 id="memories-title">Memories</h1>
                <p className="page-description">{appSubtitle}</p>
              </div>
              <Button
                ref={newMemoryButtonRef}
                variant="primary"
                onClick={() => setComposerOpen(true)}
              >
                <PlusIcon />
                New Memory
              </Button>
            </header>

            {error && (
              <div className="inline-error" role="alert">
                <div>
                  <strong>Couldn&apos;t complete that request.</strong>
                  <span>{error}</span>
                </div>
                <Button variant="ghost" onClick={() => setError(null)}>
                  Dismiss
                </Button>
              </div>
            )}

            <div className="results-heading">
              <div>
                <span>{query ? "Ranked recall" : "Recent memory"}</span>
                {query && <strong>“{query}”</strong>}
              </div>
              <span>{resultsLoading ? "Searching…" : `${memories.length} shown`}</span>
            </div>

            <div className="memory-list" aria-live="polite" aria-busy={resultsLoading}>
              {memories.map((memory) => (
                <button
                  className="memory-row"
                  type="button"
                  key={memory.id}
                  onClick={() => openMemory(memory)}
                >
                  <span className="memory-row-copy">
                    <strong>{memoryPreview(searchEvidence[memory.id] ?? memory.content)}</strong>
                    <small>
                      {memory.createdByAgentId ? "Agent provenance" : "Created by user"}
                    </small>
                  </span>
                  <span className="memory-scope">{memory.scope}</span>
                  <span className="memory-date">{displayDate(memory.updatedAt)}</span>
                </button>
              ))}

              {!memories.length && !resultsLoading && (
                <div className="empty-state">
                  <span className="empty-mark" aria-hidden="true">
                    ○
                  </span>
                  <h2>{query ? "Nothing recalled." : "No Memories yet."}</h2>
                  <p>
                    {query
                      ? "Try a different phrase. Visibility is filtered before ranking."
                      : "Capture the first durable fact for this Workspace."}
                  </p>
                  {!query && (
                    <Button variant="secondary" onClick={() => setComposerOpen(true)}>
                      <PlusIcon />
                      New Memory
                    </Button>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {composerOpen && (
        <dialog
          ref={composerDialogRef}
          className="modal-layer"
          aria-labelledby="composer-title"
          onCancel={(event) => {
            event.preventDefault();
            closeComposer();
          }}
        >
          <button
            className="modal-scrim"
            type="button"
            tabIndex={-1}
            aria-label="Close composer"
            onClick={closeComposer}
          />
          <form className="composer-panel" onSubmit={createMemory}>
            <header className="panel-header">
              <div>
                <p className="page-eyebrow">Capture</p>
                <h2 id="composer-title">New Memory</h2>
              </div>
              <Button variant="icon" aria-label="Close composer" onClick={closeComposer}>
                <CloseIcon />
              </Button>
            </header>
            <label htmlFor="memory-draft">What should humans and agents remember?</label>
            <textarea
              ref={draftRef}
              id="memory-draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              maxLength={1_000_000}
              placeholder="Write a durable fact, decision, preference, or piece of context…"
            />
            <div className="panel-actions">
              <ScopeControl value={draftScope} onChange={setDraftScope} label="Memory scope" />
              <div>
                <Button variant="ghost" onClick={closeComposer}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" disabled={saving || !draft.trim()}>
                  {saving ? "Remembering…" : "Remember"}
                </Button>
              </div>
            </div>
          </form>
        </dialog>
      )}

      {creatingWorkspace && (
        <dialog
          ref={workspaceDialogRef}
          className="modal-layer"
          aria-labelledby="workspace-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            closeWorkspaceCreator();
          }}
        >
          <button
            className="modal-scrim"
            type="button"
            tabIndex={-1}
            aria-label="Close Workspace creator"
            onClick={closeWorkspaceCreator}
          />
          <form className="workspace-dialog" onSubmit={createWorkspace}>
            <header className="panel-header">
              <div>
                <p className="page-eyebrow">Memory boundary</p>
                <h2 id="workspace-dialog-title">New Workspace</h2>
              </div>
              <Button
                variant="icon"
                aria-label="Close Workspace creator"
                onClick={closeWorkspaceCreator}
              >
                <CloseIcon />
              </Button>
            </header>
            <label htmlFor="new-workspace-name">Workspace name</label>
            <input
              ref={workspaceNameRef}
              id="new-workspace-name"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Acme Research"
              maxLength={120}
            />
            <div className="dialog-actions">
              <Button variant="ghost" onClick={closeWorkspaceCreator}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={saving || !workspaceName.trim()}>
                {saving ? "Creating…" : "Create Workspace"}
              </Button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}

function ScopeControl({
  value,
  label,
  onChange,
}: {
  value: Memory["scope"];
  label: string;
  onChange: (scope: Memory["scope"]) => void;
}) {
  return (
    <fieldset className="scope-control">
      <legend>{label}</legend>
      {(["shared", "private"] as const).map((scope) => (
        <button
          key={scope}
          type="button"
          aria-pressed={value === scope}
          className={value === scope ? "scope-selected" : ""}
          onClick={() => onChange(scope)}
        >
          {scope}
        </button>
      ))}
    </fieldset>
  );
}

function MemoryDetail({
  memory,
  content,
  scope,
  saving,
  error,
  backLabel,
  onBack,
  onContentChange,
  onScopeChange,
  onSubmit,
  onForget,
  onDismissError,
}: {
  memory: Memory;
  content: string;
  scope: Memory["scope"];
  saving: boolean;
  error: string | null;
  backLabel: string;
  onBack: () => void;
  onContentChange: (content: string) => void;
  onScopeChange: (scope: Memory["scope"]) => void;
  onSubmit: (event: React.FormEvent) => void;
  onForget: () => void;
  onDismissError: () => void;
}) {
  return (
    <section className="page-wrap page-wrap-wide view-anim" aria-labelledby="memory-detail-title">
      <Button variant="ghost" className="back-link" onClick={onBack}>
        <ArrowLeftIcon />
        {backLabel}
      </Button>
      {error && (
        <div className="inline-error" role="alert">
          <div>
            <strong>Couldn&apos;t complete that request.</strong>
            <span>{error}</span>
          </div>
          <Button variant="ghost" onClick={onDismissError}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="memory-detail-grid">
        <form className="memory-detail-panel" onSubmit={onSubmit}>
          <header>
            <p className="page-eyebrow">Memory · v{memory.version}</p>
            <h1 id="memory-detail-title">Memory detail</h1>
            <p className="memory-id">{memory.id}</p>
          </header>
          <label htmlFor="memory-content">Content</label>
          <textarea
            id="memory-content"
            value={content}
            onChange={(event) => onContentChange(event.target.value)}
            rows={16}
          />
          <footer className="detail-actions">
            <Button variant="danger" onClick={onForget} disabled={saving}>
              Forget
            </Button>
            <Button variant="primary" type="submit" disabled={saving || !content.trim()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </footer>
        </form>

        <aside className="memory-context" aria-label="Memory context">
          <section className="context-section">
            <div className="context-heading">
              <h2>Properties</h2>
            </div>
            <ScopeControl value={scope} onChange={onScopeChange} label="Scope" />
            <dl className="property-list">
              <div>
                <dt>Owner</dt>
                <dd>{memory.ownerUserId}</dd>
              </div>
              <div>
                <dt>Created by</dt>
                <dd>{memory.createdByAgentId ?? "User"}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{displayDate(memory.createdAt)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{displayDate(memory.updatedAt)}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>v{memory.version}</dd>
              </div>
            </dl>
          </section>
          <section className="context-section">
            <div className="context-heading">
              <h2>Retrieval</h2>
            </div>
            <p className="context-note">
              Visibility is enforced by Postgres before this Memory can enter a ranked result.
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}
