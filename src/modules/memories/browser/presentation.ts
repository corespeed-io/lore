import type { Memory } from "@corespeed/lore-sdk";
import { GRAPH_NODE_LIMIT } from "@/modules/graph/browser/types";
import { displayCount, type ReadState, UNKNOWN_COUNT } from "@/shared/browser/read-state";

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

export interface MemoryGraphContext {
  /** The Connections property: a count, or "—" when the Graph cannot say. */
  connections: string;
  /** Replaces the Related list whenever the Graph cannot vouch for it. */
  relatedNotice: string | null;
  /** Title of a wikilink that did not resolve to one visible Graph node. */
  unresolvedWikilinkTitle: string;
}

const GRAPH_WINDOW = `the Graph's ${displayCount(GRAPH_NODE_LIMIT, "ready")}-Memory read window`;

/**
 * What Memory detail may claim from the Workspace Graph. Wikilinks, Related, and
 * Connections all resolve against that one read, so before it loads, after it
 * fails, or for a Memory outside its capped window, none of them may claim zero
 * or "not found".
 */
export function memoryGraphContext(input: {
  state: ReadState;
  capped: boolean;
  inGraph: boolean;
  relatedCount: number;
}): MemoryGraphContext {
  if (input.state === "loading") {
    return {
      connections: UNKNOWN_COUNT,
      relatedNotice: "Loading related Memories…",
      unresolvedWikilinkTitle: "Resolving Memory reference…",
    };
  }
  if (input.state === "error") {
    return {
      connections: UNKNOWN_COUNT,
      relatedNotice: "Related Memories are currently unavailable.",
      unresolvedWikilinkTitle: "Memory references are unavailable until the Graph loads",
    };
  }
  const unresolvedWikilinkTitle = input.capped
    ? `Memory reference is not in ${GRAPH_WINDOW}`
    : "Memory reference not found";
  if (!input.inGraph) {
    return {
      connections: UNKNOWN_COUNT,
      relatedNotice: input.capped
        ? `This Memory is outside ${GRAPH_WINDOW}.`
        : "This Memory is not in the loaded Graph yet.",
      unresolvedWikilinkTitle,
    };
  }
  return {
    connections: displayCount(input.relatedCount, "ready", input.capped),
    relatedNotice:
      input.capped && input.relatedCount === 0 ? `No affinities inside ${GRAPH_WINDOW}.` : null,
    unresolvedWikilinkTitle,
  };
}
