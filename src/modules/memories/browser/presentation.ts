import type { Memory } from "@corespeed/lore-sdk";
import { displayCount } from "@/shared/browser/read-state";

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export function memoryTitle(memory: Memory): string {
  const configured = memory.metadata.title;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const firstLine = memory.content.split(/\r?\n/, 1)[0] ?? memory.content;
  return compact(firstLine.replace(/^#+\s*/, ""), 96) || "Untitled memory";
}

/** The `metadata.type` a Memory actually carries, or null when it has none. */
export function memoryConfiguredType(memory: Memory): string | null {
  const configured = memory.metadata.type;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

/**
 * The grouping bucket for type chips and breakdowns. An untyped Memory falls
 * back to its scope, so rows still state scope as separate text: a typed row's
 * bucket says nothing about who can see it.
 */
export function memoryType(memory: Memory): string {
  return memoryConfiguredType(memory) ?? memory.scope;
}

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** A row's update date in UTC, so every viewer sees the day the server recorded. */
export function shortMemoryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : SHORT_DATE_FORMAT.format(date);
}

const PREFERRED_TYPE_ORDER = ["concept", "product", "person", "company"];

export function typeLabel(type: string): string {
  return (type.trim() || "other").replace(/[_-]/g, " ");
}

export function typeSort(a: string, b: string): number {
  const ai = PREFERRED_TYPE_ORDER.indexOf(a);
  const bi = PREFERRED_TYPE_ORDER.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  return a.localeCompare(b);
}

/** What Memory detail may claim from the Workspace Graph (see graph/browser/memory-context.ts). */
export interface MemoryGraphContext {
  /** The Connections property: a count, or "—" when the Graph cannot say. */
  connections: string;
  /** Replaces the Related list whenever the Graph cannot vouch for it. */
  relatedNotice: string | null;
  /** Title of a wikilink that did not resolve to one visible Graph node. */
  unresolvedWikilinkTitle: string;
}

/**
 * The browse header's counts. Until the browse window is read in full (pages are
 * still loading, or it stopped at the browse cap) each is a lower bound, "N+".
 */
export function browseCounts(input: {
  /** Loaded Memories that match the type filter, however many rows are rendered. */
  matching: number;
  total: number;
  filtered: boolean;
  complete: boolean;
}): { heading: string; count: (value: number) => string } {
  const count = (value: number) => displayCount(value, "ready", !input.complete);
  // The noun agrees with the count beside it; a lower bound such as "1+" is plural.
  const noun = (value: number) => (input.complete && value === 1 ? "memory" : "memories");
  const heading = input.filtered
    ? `Showing ${count(input.matching)} of ${count(input.total)} ${noun(input.total)}`
    : `Showing ${count(input.matching)} ${noun(input.matching)}`;
  return { heading, count };
}

/**
 * The browse type chips: "All", then every loaded type in the preferred order. The
 * active filter keeps its chip even when no loaded Memory has that type (a deep link,
 * or its last Memory was forgotten), so the applied filter stays visible.
 */
export function browseTypeChips(
  loadedTypes: readonly string[],
  typeFilter: string,
): [key: string, label: string][] {
  const types = [...new Set(loadedTypes)];
  if (typeFilter !== "all" && !types.includes(typeFilter)) types.push(typeFilter);
  return [
    ["all", "All"],
    ...types.sort(typeSort).map((type): [string, string] => [type, typeLabel(type)]),
  ];
}

/** What browse says when a type filter matches no loaded Memory, or null. */
export function browseFilterEmptyNote(input: {
  matching: number;
  filtered: boolean;
  complete: boolean;
}): string | null {
  if (!input.filtered || input.matching > 0) return null;
  return input.complete ? "No Memories of this type." : "No Memories of this type have loaded yet.";
}
