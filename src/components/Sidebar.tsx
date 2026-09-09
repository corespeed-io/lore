"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { Tab } from "@/lib/route";
import type { WorkspaceSummary } from "@/lib/types";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";

interface SidebarProps {
  activeTab: Tab;
  activeWorkspaceId: string;
  workspaces: WorkspaceSummary[];
  onWorkspaceChange: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onNewMemory: () => void;
  onTabChange: (tab: Tab) => void;
  onSearch: (q: string) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  /** App resets query context (tab change, drill, route, Workspace); it must be
   * able to drop a pending debounced search from every one of those paths. */
  searchCancelRef?: React.RefObject<(() => void) | null>;
}

// Product brand — the app is Lore; APP_TITLE names the deployment.
const BRAND = "Lore";

const NAV: { id: Tab; label: string }[] = [
  { id: "overview", label: "Dashboard" },
  { id: "graph", label: "Graph" },
  { id: "search", label: "Memories" },
  { id: "agents", label: "Agents" },
  { id: "proposals", label: "Proposals" },
  { id: "operations", label: "Operations" },
];

const ICONS: Partial<Record<Tab, React.ReactNode>> = {
  overview: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  ),
  graph: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="3.5" cy="4" r="1.8" />
      <circle cx="12" cy="3.5" r="1.8" />
      <circle cx="8" cy="12" r="1.8" />
      <path d="M5.1 4.8 6.9 10.4M10.4 4.6 8.8 10.4M5.2 3.9 10.3 3.6" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d="M5.3 3.2A3.3 3.3 0 0 0 2.5 6.5c0 .9.3 1.7.9 2.3-.2 1.8 1.1 3.2 2.8 3.2.8 0 1.5-.3 2-.8.6.5 1.3.8 2.1.8 1.7 0 3-1.4 2.8-3.2.6-.6.9-1.4.9-2.3a3.3 3.3 0 0 0-2.8-3.3A3.3 3.3 0 0 0 8.3 1.7a3.4 3.4 0 0 0-3 1.5Z"
        strokeLinejoin="round"
      />
      <path d="M6 5.3h4.2M5.5 8h5.2M6.5 10.6h3.4" strokeLinecap="round" />
    </svg>
  ),
  agents: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="10" height="8" rx="2" />
      <path d="M8 2v2.5M5.5 8h.01M10.5 8h.01M6 10.5h4" strokeLinecap="round" />
    </svg>
  ),
  proposals: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M4 2.5h6l2 2v9H4z" strokeLinejoin="round" />
      <path d="M10 2.5v2h2M6 7h4M6 9.5h4M6 12h2.5" strokeLinecap="round" />
    </svg>
  ),
  operations: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M3 3.5h10v3H3zM3 9.5h10v3H3z" strokeLinejoin="round" />
      <path d="M5.5 5h5M5.5 11h5" strokeLinecap="round" />
    </svg>
  ),
};

export function Sidebar({
  activeTab,
  activeWorkspaceId,
  workspaces,
  onWorkspaceChange,
  onCreateWorkspace,
  onNewMemory,
  onTabChange,
  onSearch,
  searchRef,
  searchCancelRef,
}: SidebarProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? localRef;
  const search = useDebouncedCallback(onSearch, 220);
  const composing = useRef(false);
  const compositionStartValue = useRef("");
  const compositionEndedAt = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!searchCancelRef) return;
    searchCancelRef.current = search.cancel;
    return () => {
      searchCancelRef.current = null;
    };
  }, [searchCancelRef, search.cancel]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Workspace changes invalidate pending searches.
  useEffect(() => {
    // Never carry a pending query into another Workspace or past unmount.
    return search.cancel;
  }, [activeWorkspaceId, search.cancel]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  function changeTab(tab: Tab) {
    onTabChange(tab);
    setMenuOpen(false);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Input events carry the live composition flag; syncing the ref from it lets
    // typing recover a composition that was aborted without a compositionend
    // (programmatic value writes can do that).
    const native = e.nativeEvent as { isComposing?: boolean };
    composing.current = native.isComposing ?? composing.current;
    if (!composing.current) search.schedule(e.currentTarget.value);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (composing.current) return;
    search.cancel();
    onSearch(inputRef.current?.value ?? "");
    setMenuOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // An Enter the IME consumed to confirm a candidate must never submit. Safari
    // can end composition before this keydown and report only keyCode 229, so a
    // bare 229 counts as composition only just after a compositionend — soft
    // keyboards that report 229 for a deliberate Enter outside composition
    // still submit.
    if (
      composing.current ||
      e.nativeEvent.isComposing ||
      (e.nativeEvent.keyCode === 229 && Date.now() - compositionEndedAt.current < 500)
    ) {
      return;
    }
    e.currentTarget.form?.requestSubmit();
  }

  const items = NAV;

  return (
    <>
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-menu-button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-controls="app-navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <button
          type="button"
          className="wordmark mobile-wordmark"
          onClick={() => changeTab("overview")}
        >
          <Image className="wordmark-mark" src="/lore-mark.svg" alt="" width={24} height={24} />
          <span className="wordmark-title">{BRAND}</span>
        </button>
      </header>

      {menuOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <aside id="app-navigation" className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>
        <div className="sidebar-head">
          <button type="button" className="wordmark" onClick={() => changeTab("overview")}>
            <Image
              className="wordmark-mark"
              src="/lore-mark.svg"
              alt=""
              width={24}
              height={24}
              priority
            />
            <span className="wordmark-title">{BRAND}</span>
          </button>
          <button
            type="button"
            className="sidebar-close"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="m4 4 8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="sidebar-workspace">
          <label htmlFor="workspace-picker">Workspace</label>
          <select
            id="workspace-picker"
            value={activeWorkspaceId}
            onChange={(event) => {
              onWorkspaceChange(event.target.value);
              setMenuOpen(false);
            }}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <button type="button" className="sidebar-workspace-create" onClick={onCreateWorkspace}>
            + New workspace
          </button>
        </div>

        <search aria-label="Search memories">
          <form className="sidebar-search-wrap" onSubmit={handleSubmit}>
            <label className="sidebar-search-label" htmlFor="memory-search">
              Search memories
            </label>
            <input
              id="memory-search"
              ref={inputRef}
              className="sidebar-search"
              placeholder="What do you remember?"
              aria-describedby="memory-search-hint"
              enterKeyHint="search"
              autoComplete="off"
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={(e) => {
                composing.current = true;
                compositionStartValue.current = e.currentTarget.value;
                search.cancel();
              }}
              onCompositionEnd={(e) => {
                composing.current = false;
                compositionEndedAt.current = Date.now();
                // A cancelled composition restores the pre-composition text;
                // nothing new to search then.
                if (e.currentTarget.value !== compositionStartValue.current) {
                  search.schedule(e.currentTarget.value);
                }
              }}
              onBlur={() => {
                // Engines commit or abort composition on blur; the guard must
                // never outlive focus.
                composing.current = false;
              }}
            />
            <p id="memory-search-hint" className="sidebar-search-hint">
              Describe a memory or ask a question.
            </p>
            <button type="submit" className="sidebar-search-submit">
              Semantic search
            </button>
          </form>
        </search>

        <nav className="nav-group" aria-label="Primary">
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={activeTab === n.id ? "page" : undefined}
              className={`nav-item${activeTab === n.id ? " nav-active" : ""}`}
              onClick={() => changeTab(n.id)}
            >
              <span className="nav-icon">{ICONS[n.id]}</span>
              {n.label}
            </button>
          ))}
        </nav>

        <button type="button" className="sidebar-new-memory" onClick={onNewMemory}>
          <span aria-hidden="true">+</span>
          New memory
        </button>
      </aside>
    </>
  );
}
