"use client";

import { useRef } from "react";

type Tab = "overview" | "graph" | "search";

interface HeaderProps {
  title: string;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onSearch: (q: string) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

export function Header({ title, activeTab, onTabChange, onSearch, searchRef }: HeaderProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? localRef;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const q = inputRef.current?.value.trim() ?? "";
      if (q) onSearch(q);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "graph", label: "Graph" },
    { id: "search", label: "Search" },
  ];

  return (
    <header className="topbar">
      {/* Wordmark */}
      <button
        type="button"
        className="wordmark"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
        onClick={() => onTabChange("overview")}
      >
        <span className="wordmark-spike">✳</span>
        <span className="wordmark-title">{title}</span>
      </button>

      {/* Search */}
      <input
        ref={inputRef}
        className="topbar-search"
        placeholder="Search the brain…"
        autoComplete="off"
        onKeyDown={handleKeyDown}
      />

      {/* Tabs */}
      <div className="tab-group" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`tab-btn${activeTab === t.id ? " tab-active" : ""}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </header>
  );
}
