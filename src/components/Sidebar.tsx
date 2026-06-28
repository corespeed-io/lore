"use client";

import type { Tab } from "@/lib/route";
import { useEffect, useRef, useState } from "react";

interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onSearch: (q: string) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  adminEnabled: boolean;
}

// Product brand — the app is "Lore"; gbrain is the backend brain it views.
const BRAND = "Lore";

const NAV: { id: Tab; label: string }[] = [
  { id: "overview", label: "Dashboard" },
  { id: "graph", label: "Graph" },
  { id: "search", label: "Memories" },
];

// gbrain admin/observability sections — same shell, shown only when admin mode
// is configured (server-gated; each section also fails closed on its own).
const ADMIN_NAV: { id: Tab; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "agents", label: "Access" },
  { id: "jobs", label: "Queue" },
  { id: "calibration", label: "Track record" },
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
  requests: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M4.5 3.5h9M4.5 8h9M4.5 12.5h9" strokeLinecap="round" />
      <circle cx="2.5" cy="3.5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12.5" r="0.8" fill="currentColor" stroke="none" />
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
      <circle cx="6" cy="5" r="2.2" />
      <path d="M2.5 13c.6-2.3 2-3.4 3.5-3.4S8.9 10.7 9.5 13" strokeLinecap="round" />
      <path d="M10.2 7.1a2 2 0 1 0 .2-4M10.8 10c1.2.2 2.2 1.2 2.7 3" strokeLinecap="round" />
    </svg>
  ),
  jobs: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2.5" y="3" width="11" height="3" rx="1" />
      <rect x="2.5" y="10" width="11" height="3" rx="1" />
      <path d="M5 8h6M8 6v4" strokeLinecap="round" />
    </svg>
  ),
  calibration: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M3 11a5.5 5.5 0 1 1 10 0" strokeLinecap="round" />
      <path d="M8 8.5 11 5" strokeLinecap="round" />
      <circle cx="8" cy="11" r="1.5" />
      <path d="M3.5 11h-1M13.5 11h-1M4.3 6.3l-.8-.8M11.7 6.3l.8-.8" strokeLinecap="round" />
    </svg>
  ),
};

export function Sidebar({
  activeTab,
  onTabChange,
  onSearch,
  searchRef,
  adminEnabled,
}: SidebarProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? localRef;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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

  // Search-as-you-type: debounce keystrokes; Enter fires immediately.
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.currentTarget.value;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => onSearch(v), 220);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (debounce.current) clearTimeout(debounce.current);
      onSearch(inputRef.current?.value ?? "");
    }
  }

  const items = adminEnabled ? [...NAV, ...ADMIN_NAV] : NAV;

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
          <img className="wordmark-mark" src="/lore-mark.svg" alt="" width="24" height="24" />
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
            <img className="wordmark-mark" src="/lore-mark.svg" alt="" width="24" height="24" />
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

        <input
          ref={inputRef}
          className="sidebar-search"
          placeholder="Search the brain…"
          autoComplete="off"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />

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
      </aside>
    </>
  );
}
