"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AgentIcon, EvaluationIcon, GraphIcon, MemoryIcon, PlusIcon, SearchIcon } from "./ui/icons";

export interface WorkspaceOption {
  id: string;
  name: string;
  role?: "owner" | "admin" | "member";
}

export type LoreView = "memories" | "graph";

interface LoreSidebarProps {
  workspaces: WorkspaceOption[];
  activeWorkspaceId: string;
  query: string;
  activeView: LoreView;
  onWorkspaceChange: (workspaceId: string) => void;
  onQueryChange: (query: string) => void;
  onCreateWorkspace: () => void;
  onNavigate: (view: LoreView) => void;
}

export function LoreSidebar({
  workspaces,
  activeWorkspaceId,
  query,
  activeView,
  onWorkspaceChange,
  onQueryChange,
  onCreateWorkspace,
  onNavigate,
}: LoreSidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  function closeMenu() {
    const shouldReturnFocus = menuOpen;
    setMenuOpen(false);
    if (shouldReturnFocus) menuButtonRef.current?.focus();
  }

  return (
    <>
      <header className="mobile-topbar">
        <button
          ref={menuButtonRef}
          type="button"
          className="mobile-menu-button"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-controls="lore-navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
        <a className="wordmark mobile-wordmark" href="/" aria-label="Lore home">
          <Image className="wordmark-mark" src="/lore-mark.svg" alt="" width={24} height={24} />
          <span className="wordmark-title">Lore</span>
        </a>
        <span className="mobile-workspace-name">{activeWorkspace?.name}</span>
      </header>

      {menuOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={closeMenu}
        />
      )}

      <aside id="lore-navigation" className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>
        <div className="sidebar-head">
          <a className="wordmark" href="/" aria-label="Lore home">
            <Image
              className="wordmark-mark"
              src="/lore-mark.svg"
              alt=""
              width={24}
              height={24}
              priority
            />
            <span className="wordmark-title">Lore</span>
          </a>
          <button
            type="button"
            className="sidebar-close"
            aria-label="Close navigation"
            onClick={closeMenu}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="workspace-control">
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
          <button
            type="button"
            className="sidebar-create"
            onClick={() => {
              setMenuOpen(false);
              onCreateWorkspace();
            }}
          >
            <PlusIcon />
            New Workspace
          </button>
        </div>

        <label className="sidebar-search">
          <SearchIcon />
          <input
            id="memory-search"
            value={query}
            placeholder="Search memories…"
            autoComplete="off"
            aria-label="Search Memories"
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <kbd>/</kbd>
        </label>

        <nav className="nav-group" aria-label="Primary navigation">
          <button
            type="button"
            className={`nav-item${activeView === "memories" ? " nav-active" : ""}`}
            aria-current={activeView === "memories" ? "page" : undefined}
            onClick={() => {
              setMenuOpen(false);
              onNavigate("memories");
            }}
          >
            <span className="nav-icon">
              <MemoryIcon />
            </span>
            Memories
          </button>
          <button
            type="button"
            className={`nav-item${activeView === "graph" ? " nav-active" : ""}`}
            aria-current={activeView === "graph" ? "page" : undefined}
            onClick={() => {
              setMenuOpen(false);
              onNavigate("graph");
            }}
          >
            <span className="nav-icon">
              <GraphIcon />
            </span>
            Graph
          </button>
          <button type="button" className="nav-item nav-disabled" disabled>
            <span className="nav-icon">
              <AgentIcon />
            </span>
            Agents
            <span className="nav-status">soon</span>
          </button>
          <button type="button" className="nav-item nav-disabled" disabled>
            <span className="nav-icon">
              <EvaluationIcon />
            </span>
            Evaluation
            <span className="nav-status">soon</span>
          </button>
        </nav>

        <div className="sidebar-foot">
          <span className="status-dot" />
          <span>Native Postgres · RLS</span>
        </div>
      </aside>
    </>
  );
}
