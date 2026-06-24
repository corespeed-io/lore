"use client";

import { useRef } from "react";

interface HeaderProps {
  title: string;
  onHome: () => void;
  onSearch: (q: string) => void;
  onGraph: () => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

export function Header({ title, onHome, onSearch, onGraph, searchRef }: HeaderProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef ?? localRef;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const q = inputRef.current?.value.trim() ?? "";
      if (q) {
        onSearch(q);
      } else {
        onHome();
      }
    }
  }

  return (
    <header>
      <b
        onClick={onHome}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onHome();
        }}
        // biome-ignore lint/a11y/useSemanticElements: matches reference app's <b> title
        role="button"
        tabIndex={0}
      >
        {title}
      </b>
      <input
        id="q"
        ref={inputRef}
        placeholder="search the brain…  (Enter)"
        autoComplete="off"
        onKeyDown={handleKeyDown}
      />
      <button className="navbtn" type="button" onClick={onGraph}>
        graph
      </button>
    </header>
  );
}
