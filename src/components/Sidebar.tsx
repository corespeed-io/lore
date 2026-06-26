"use client";

import { useRef } from "react";

type Tab = "overview" | "graph" | "search";

interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onSearch: (q: string) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

// Product brand — the app is "Lore"; gbrain is the backend brain it views.
const BRAND = "Lore";

const NAV: { id: Tab; label: string }[] = [
  { id: "overview", label: "Dashboard" },
  { id: "graph", label: "Graph" },
  { id: "search", label: "Memories" },
];

const ICONS: Record<Tab, React.ReactNode> = {
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
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" strokeLinecap="round" />
    </svg>
  ),
};

export function Sidebar({ activeTab, onTabChange, onSearch, searchRef }: SidebarProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? localRef;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <aside className="sidebar">
      <button
        type="button"
        className="wordmark"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
        onClick={() => onTabChange("overview")}
      >
        <img className="wordmark-mark" src="/lore-mark.svg" alt="" width="24" height="24" />
        <span className="wordmark-title">{BRAND}</span>
      </button>

      <input
        ref={inputRef}
        className="sidebar-search"
        placeholder="Search the brain…"
        autoComplete="off"
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      <nav className="nav-group" aria-label="Primary">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={activeTab === n.id ? "page" : undefined}
            className={`nav-item${activeTab === n.id ? " nav-active" : ""}`}
            onClick={() => onTabChange(n.id)}
          >
            <span className="nav-icon">{ICONS[n.id]}</span>
            {n.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
