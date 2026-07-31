"use client";

// The answer to a knowledge base's signature complaint: "I imported everything
// and the graph looks empty." Two numbers explain it — refs pointing at pages
// that do not exist (usually a typo, or a note left out of the import), and
// pages nothing points at. Both are one indexed query, and both are actionable
// in a way a page count never is.
//
// Degrades to nothing: against a backend that does not implement these tools
// the panel simply does not render, so lore keeps working against a plain
// gbrain.

import { apiCall } from "@/lib/api";
import { useEffect, useState } from "react";

interface BrokenLink {
  from_slug: string;
  ref: string;
}
interface Orphan {
  slug: string;
  title: string;
}

const SHOW = 5;

export function GraphHealth({ onOpen }: { onOpen: (slug: string) => void }) {
  const [broken, setBroken] = useState<BrokenLink[] | null>(null);
  const [orphans, setOrphans] = useState<Orphan[] | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    let live = true;
    Promise.all([
      apiCall("list_broken_links", { limit: 200 }),
      apiCall("find_orphans", { limit: 200 }),
    ])
      .then(([b, o]) => {
        if (!live) return;
        setBroken(Array.isArray(b) ? (b as BrokenLink[]) : []);
        setOrphans(Array.isArray(o) ? (o as Orphan[]) : []);
      })
      .catch(() => {
        if (live) setSupported(false);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!supported || broken === null || orphans === null) return null;
  if (broken.length === 0 && orphans.length === 0) return null;

  return (
    <div className="panel-card">
      <p className="panel-card-title">Graph health</p>

      {broken.length > 0 && (
        <>
          <p className="graph-health-line">
            <strong>{broken.length}</strong> {broken.length === 1 ? "link points" : "links point"}{" "}
            at a page that does not exist
          </p>
          <ul className="graph-health-list">
            {broken.slice(0, SHOW).map((b) => (
              <li key={`${b.from_slug}|${b.ref}`}>
                <code>{b.ref}</code>{" "}
                <button
                  type="button"
                  className="graph-health-src"
                  onClick={() => onOpen(b.from_slug)}
                >
                  in {b.from_slug}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {orphans.length > 0 && (
        <>
          <p className="graph-health-line">
            <strong>{orphans.length}</strong> {orphans.length === 1 ? "page has" : "pages have"} no
            inbound links
          </p>
          <ul className="graph-health-list">
            {orphans.slice(0, SHOW).map((o) => (
              <li key={o.slug}>
                <button type="button" className="graph-health-src" onClick={() => onOpen(o.slug)}>
                  {o.title || o.slug}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
