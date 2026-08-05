"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";

interface MemoryConsoleProps {
  appTitle: string;
  appSubtitle: string;
}

interface Workspace {
  id: string;
  name: string;
  role?: "owner" | "admin" | "member";
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

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function memoryPreview(content: string): string {
  return content.length > 240 ? `${content.slice(0, 237).trimEnd()}…` : content;
}

export function MemoryConsole({ appTitle, appSubtitle }: MemoryConsoleProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchEvidence, setSearchEvidence] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
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

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await requestJson<Workspace[]>("/api/workspaces");
      setWorkspaces(loaded);
      const stored = window.localStorage.getItem("lore.workspace");
      const next = loaded.find((workspace) => workspace.id === stored)?.id ?? loaded[0]?.id ?? "";
      setActiveWorkspaceId(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
          if ((cause as Error).name !== "AbortError") {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      },
      query ? 220 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeWorkspaceId, query]);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceName.trim()) return;
    setSaving(true);
    try {
      const workspace = await requestJson<Workspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: workspaceName }),
      });
      setWorkspaces((current) => [...current, { ...workspace, role: "owner" }]);
      setActiveWorkspaceId(workspace.id);
      setWorkspaceName("");
      setCreatingWorkspace(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  function openMemory(memory: Memory) {
    setSelected(memory);
    setEditContent(memory.content);
    setEditScope(memory.scope);
  }

  async function updateMemory(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !editContent.trim()) return;
    setSaving(true);
    try {
      const updated = await requestJson<Memory>(
        `/api/memories/${selected.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ content: editContent, scope: editScope }),
        },
        activeWorkspaceId,
      );
      setMemories((current) =>
        current.map((memory) => (memory.id === updated.id ? updated : memory)),
      );
      setSelected(updated);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="memory-loading">
        <Image src="/lore-mark.svg" alt="" width={30} height={30} priority />
        <span>Opening Lore…</span>
      </main>
    );
  }

  if (!workspaces.length) {
    return (
      <main className="onboarding-shell">
        <section className="onboarding-copy">
          <a className="memory-brand" href="/" aria-label="Lore home">
            <Image src="/lore-mark.svg" alt="" width={28} height={28} priority />
            <span>Lore</span>
          </a>
          <p className="memory-eyebrow">Your first memory boundary</p>
          <h1>Create a Workspace.</h1>
          <p>
            A Workspace is Lore&apos;s only tenant. It contains members, permitted Agents, and the
            Memories they are allowed to see.
          </p>
        </section>
        <form className="onboarding-form" onSubmit={createWorkspace}>
          <label htmlFor="workspace-name">Workspace name</label>
          <input
            id="workspace-name"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="Acme Research"
            maxLength={120}
          />
          <button type="submit" disabled={saving || !workspaceName.trim()}>
            {saving ? "Creating…" : "Create Workspace"}
          </button>
          {error && <p className="form-error">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <div className="memory-shell">
      <aside className="memory-rail">
        <a className="memory-brand" href="/" aria-label="Lore home">
          <Image src="/lore-mark.svg" alt="" width={26} height={26} priority />
          <span>Lore</span>
        </a>

        <div className="workspace-picker">
          <label htmlFor="workspace-picker">Workspace</label>
          <select
            id="workspace-picker"
            value={activeWorkspaceId}
            onChange={(event) => setActiveWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <button
            className="text-button"
            type="button"
            onClick={() => setCreatingWorkspace((current) => !current)}
          >
            + New Workspace
          </button>
        </div>

        {creatingWorkspace && (
          <form className="rail-workspace-form" onSubmit={createWorkspace}>
            <input
              aria-label="New Workspace name"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Workspace name"
              maxLength={120}
            />
            <button type="submit" disabled={saving || !workspaceName.trim()}>
              Add
            </button>
          </form>
        )}

        <nav className="memory-nav" aria-label="Main navigation">
          <span className="memory-nav-item active">
            <span className="nav-dot" /> Memories
          </span>
          <span className="memory-nav-item disabled">
            Agents <small>soon</small>
          </span>
          <span className="memory-nav-item disabled">
            Evaluation <small>soon</small>
          </span>
        </nav>

        <div className="rail-foot">
          <span className="rail-signal" />
          Native Postgres · RLS
        </div>
      </aside>

      <main className="memory-main">
        <header className="memory-header">
          <div>
            <p className="memory-eyebrow">{activeWorkspace?.name ?? "Workspace"}</p>
            <h1>{appTitle}</h1>
            <p>{appSubtitle}</p>
          </div>
          <button className="primary-button" type="button" onClick={() => setComposerOpen(true)}>
            New Memory
          </button>
        </header>

        <section className="memory-toolbar" aria-label="Memory tools">
          <label className="memory-search">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.4 10.4 3.1 3.1" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search this Workspace…"
              aria-label="Search Memories"
            />
          </label>
          <span className="memory-count">{memories.length} shown</span>
        </section>

        {composerOpen && (
          <form className="memory-composer" onSubmit={createMemory}>
            <div className="composer-topline">
              <span className="memory-eyebrow">Capture Memory</span>
              <button className="icon-button" type="button" onClick={() => setComposerOpen(false)}>
                ×<span className="sr-only">Close composer</span>
              </button>
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="What should humans and agents remember?"
              rows={5}
              maxLength={1_000_000}
            />
            <div className="composer-actions">
              <fieldset className="scope-switch">
                <legend className="sr-only">Memory scope</legend>
                {(["shared", "private"] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    className={draftScope === scope ? "selected" : ""}
                    onClick={() => setDraftScope(scope)}
                  >
                    {scope}
                  </button>
                ))}
              </fieldset>
              <button className="primary-button" type="submit" disabled={saving || !draft.trim()}>
                {saving ? "Remembering…" : "Remember"}
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className="memory-error" role="alert">
            <strong>Couldn&apos;t complete that request.</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <section className="memory-ledger" aria-live="polite">
          <div className="ledger-heading">
            <span>{query ? "Ranked recall" : "Recent memory"}</span>
            <span>Scope</span>
            <span>Updated</span>
          </div>
          {memories.map((memory, index) => (
            <button
              className="memory-row"
              type="button"
              key={memory.id}
              onClick={() => openMemory(memory)}
            >
              <span className="memory-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="memory-copy">
                {memoryPreview(searchEvidence[memory.id] ?? memory.content)}
                {memory.createdByAgentId && <small>Agent provenance</small>}
              </span>
              <span className={`scope-pill ${memory.scope}`}>{memory.scope}</span>
              <span className="memory-date">{displayDate(memory.updatedAt)}</span>
            </button>
          ))}
          {!memories.length && (
            <div className="memory-empty">
              <span className="empty-glyph">○</span>
              <h2>{query ? "Nothing recalled." : "No Memories yet."}</h2>
              <p>
                {query
                  ? "Try a different phrase. Visibility is filtered before ranking."
                  : "Capture the first durable fact for this Workspace."}
              </p>
            </div>
          )}
        </section>
      </main>

      {selected && (
        <dialog open className="memory-drawer" aria-label="Edit Memory">
          <button className="drawer-scrim" type="button" onClick={() => setSelected(null)}>
            <span className="sr-only">Close Memory</span>
          </button>
          <form className="drawer-panel" onSubmit={updateMemory}>
            <div className="drawer-head">
              <div>
                <p className="memory-eyebrow">Memory · v{selected.version}</p>
                <p className="drawer-id">{selected.id}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setSelected(null)}>
                ×<span className="sr-only">Close</span>
              </button>
            </div>
            <label htmlFor="memory-content">Content</label>
            <textarea
              id="memory-content"
              value={editContent}
              onChange={(event) => setEditContent(event.target.value)}
              rows={14}
            />
            <p className="field-label">Scope</p>
            <div className="scope-switch drawer-scope">
              {(["shared", "private"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className={editScope === scope ? "selected" : ""}
                  onClick={() => setEditScope(scope)}
                >
                  {scope}
                </button>
              ))}
            </div>
            <dl className="memory-meta">
              <div>
                <dt>Owner</dt>
                <dd>{selected.ownerUserId}</dd>
              </div>
              <div>
                <dt>Created by</dt>
                <dd>{selected.createdByAgentId ?? "User"}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{displayDate(selected.updatedAt)}</dd>
              </div>
            </dl>
            <div className="drawer-actions">
              <button
                className="danger-button"
                type="button"
                onClick={forgetMemory}
                disabled={saving}
              >
                Forget
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={saving || !editContent.trim()}
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
