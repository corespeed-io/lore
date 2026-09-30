import { LORE_CONTRACT, type Memory } from "@corespeed/lore-sdk";
import {
  hasVisibleText,
  plain,
  plainInline,
  prefix,
  revealHidden,
} from "@/modules/memories/browser/markdown";
import { displayCount } from "@/shared/browser/read-state";

// Other modules read Memory text through this file alone.
export { hasVisibleText, plain, plainInline, revealHidden };

/** Text with each whitespace run as one space, trimmed. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compact(value: string, limit: number): string {
  const text = collapse(value);
  return text.length <= limit ? text : `${prefix(text, limit - 1).trimEnd()}…`;
}

const TITLE_LIMIT = 96;
/**
 * A title reads at most this much of its source, a first line that may be the whole
 * 32k body: enough for 96 characters of words, and it bounds the parse of each row.
 */
const TITLE_SOURCE_LIMIT = 300;

/** A metadata string a Memory carries, trimmed, or null when it has none. */
function metadataText(memory: Memory, key: "title" | "type" | "source"): string | null {
  const value = memory.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function configuredTitle(memory: Memory): string | null {
  return metadataText(memory, "title");
}

/** A text's first line. The split stops there, however long the body. */
function firstLine(text: string): string {
  return text.split(/\r\n?|\n/, 1)[0] ?? "";
}

/**
 * A title from `read`, the part of its source a title reads; a source cut short
 * ends in "…", so a title never looks whole when it is not. Words that show nothing
 * leave a configured title as written, and a first line as "Untitled memory". The
 * result shows at most `limit` characters, cut as rows cut it.
 */
function readTitle(read: string, cut: boolean, configured: boolean, limit = TITLE_LIMIT): string {
  const words = plainInline(read);
  const ellipsis = cut ? "…" : "";
  if (hasVisibleText(words)) return compact(`${words.trimEnd()}${ellipsis}`, limit);
  if (!configured) return "Untitled memory";
  return compact(`${revealHidden(read).trimEnd()}${ellipsis}`, limit);
}

/** Enough cached titles or labels for two full browse windows. */
const CACHE_LIMIT = 2 * LORE_CONTRACT.limits.graphNodes;

/** A copy of text that shares no memory with the string it came from. */
function own(text: string): string {
  return ` ${text}`.slice(1);
}

/**
 * A cache of text read once per key, keeping at most `limit` entries, the oldest
 * going first. Keys and values are copied: a slice of a Memory's text would keep the
 * whole text alive in V8 long after the Memory is gone.
 */
export function textCache(limit = CACHE_LIMIT): (key: string, read: () => string) => string {
  const values = new Map<string, string>();
  // Keys in the order they came, so the oldest is found without walking the Map.
  const order: string[] = [];
  let oldest = 0;
  return (key, read) => {
    const hit = values.get(key);
    if (hit !== undefined) return hit;
    const value = own(read());
    const owned = own(key);
    if (order.length < limit) {
      order.push(owned);
    } else {
      values.delete(order[oldest]);
      order[oldest] = owned;
      oldest = (oldest + 1) % limit;
    }
    values.set(owned, value);
    return value;
  };
}

/** Titles by what they read: rows render often, fresh reads bring new objects, and a title costs a parse. */
const titles = textCache();

/** The title a row shows, cut at the title limit. */
export function memoryTitle(memory: Memory): string {
  const configured = configuredTitle(memory);
  // Past what a title reads, the first line's length only decides whether it was cut,
  // which one character more shows.
  const source = configured ?? firstLine(memory.content.slice(0, TITLE_SOURCE_LIMIT + 1));
  const read = prefix(source, TITLE_SOURCE_LIMIT);
  const cut = read.length < source.length;
  // Everything a title depends on: which source it reads, what, and whether it was cut.
  const key = `${configured === null ? "line" : "title"}${cut ? "…" : ""}\n${read}`;
  return titles(key, () => readTitle(read, cut, configured !== null));
}

/**
 * The title Memory detail shows: a configured one whole, since the body never holds
 * it, and a first-line one as rows do, since its line stays in the body whenever the
 * title cuts it short.
 */
export function memoryDetailTitle(memory: Memory): string {
  const configured = configuredTitle(memory);
  if (configured === null) return memoryTitle(memory);
  return readTitle(configured, false, true, Number.POSITIVE_INFINITY);
}

/**
 * Metadata as written, hidden controls as markers: one top-level key to a line, its
 * value compact JSON. Indenting nested values would repeat the indent on every line
 * of them, which squares the length of a value nested thousands deep.
 */
export function metadataSource(metadata: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(metadata);
  if (keys.length === 0) return "{}";
  const lines = keys.map((key) => `  ${JSON.stringify(key)}: ${compactValue(metadata[key])}`);
  return revealHidden(`{\n${lines.join(",\n")}\n}`);
}

/**
 * A metadata value as compact JSON. An engine whose stack is shallower than the
 * server's cannot serialize the deepest values the server accepts, and then only
 * that value says so, so every other key still shows.
 */
function compactValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "⟨nests too deeply to show⟩";
  }
}

/**
 * A Memory's metadata for Show source, or null when it has none: agents read every
 * key, so Show source shows every key.
 */
export function memoryMetadataText(memory: Memory): string | null {
  return Object.keys(memory.metadata).length === 0 ? null : metadataSource(memory.metadata);
}

/** A configured `metadata.title` as written, hidden controls as markers, or null. */
export function memoryConfiguredTitle(memory: Memory): string | null {
  const configured = configuredTitle(memory);
  return configured === null ? null : revealHidden(configured);
}

/** A first line written as a title: a heading, or a line that opens with a bold or 【…】 run. */
const TITLE_START = /^(?:#{1,6}[ \t]|\*\*[^*\n]+\*\*|【[^】\n]+】)/;
/** Markup a title would read differently; a line holding any stays in the body. */
const MARKUP = /[`*_[\]<>&\\~|]/;
/**
 * A line that opens a block of its own (blank, a list item, a heading, a quote, or
 * text that starts with a letter, or with a number that is not a list marker), so
 * the title line above it can go without changing how it parses.
 */
const OPENS_BLOCK =
  /^(?:[ \t]*$|[ \t]{0,3}(?:[-*+][ \t]+\S|1[.)][ \t]+\S|#{1,6}(?:[ \t]|$)|>)|\p{L}|\p{N}(?!\p{N}*[.)]))/u;

/**
 * The content Memory detail renders under its title. When a first line written as
 * a title is nothing but the words the title shows, the body starts after that line
 * rather than repeating it: a heading always ends at its line, and a bold or 【…】
 * line needs the next line to open a block of its own. Anything else keeps the line,
 * since the source view is one click away but a dropped line is gone from the page.
 */
export function memoryBody(memory: Memory): string {
  const line = firstLine(memory.content);
  if (configuredTitle(memory) !== null || !TITLE_START.test(line)) return memory.content;
  const words = line.replace(/^#{1,6}[ \t]+/, "").replace(/^\*\*([^*\n]+)\*\*/, "$1");
  if (line.length > TITLE_SOURCE_LIMIT || MARKUP.test(words)) return memory.content;
  // Measured as the title shows it, with any hidden control grown into its marker.
  if (collapse(plainInline(line)).length > TITLE_LIMIT) {
    return memory.content;
  }
  const rest = memory.content.slice(line.length).replace(/^(?:\r\n?|\n)/, "");
  // An ATX heading always ends at its line; any other title line could continue.
  if (!line.startsWith("#") && !OPENS_BLOCK.test(firstLine(rest))) return memory.content;
  return rest.replace(/^(?:\r\n?|\n)+/, "");
}

/** A type or source label shows at most this many characters of it. */
const LABEL_LIMIT = 96;
/** Labels by what they show: views list every type and source on each render. */
const labels = textCache();

/**
 * A metadata string as a label shows it: cut to the label limit, with hidden
 * controls as markers. Types and sources stay as written wherever they are keys,
 * so two values never merge into one chip, filter, or source.
 */
export function metadataLabel(value: string): string {
  const read = prefix(value, LABEL_LIMIT);
  const key = read.length < value.length ? `${read}…` : read;
  // Measured as it shows, with each hidden control grown into its marker.
  return labels(key, () => compact(revealHidden(key), LABEL_LIMIT));
}

/** A row's excerpt of text as it reads: whitespace collapsed, hidden controls as markers. */
export function excerpt(text: string, limit: number): string {
  const source = text.trimStart();
  // Four times what it shows usually fills it once whitespace collapses; "…" says it was cut.
  const read = prefix(source, 4 * limit);
  const ellipsis = read.length < source.length ? "…" : "";
  return compact(`${revealHidden(read).trimEnd()}${ellipsis}`, limit);
}

/** The `metadata.type` a Memory actually carries, or null when it has none. */
export function memoryConfiguredType(memory: Memory): string | null {
  return metadataText(memory, "type");
}

/** The `metadata.source` a Memory names, or null. */
export function memorySource(memory: Memory): string | null {
  return metadataText(memory, "source");
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
  return metadataLabel(type.trim() || "other").replace(/[_-]/g, " ");
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

/**
 * What browse says when a type filter matches no loaded Memory, or null. It names
 * the type, so it reads on its own; a scope bucket (an untyped Memory's type is its
 * scope) is named as untyped. It says "yet" only while pages still load: at the
 * browse cap, or after a page failed, no more will arrive.
 */
export function browseFilterEmptyNote(input: {
  type: string;
  matching: number;
  complete: boolean;
  capped: boolean;
  /** A browse page failed, so loading stopped short of the window. */
  stopped: boolean;
  /** How many Memories browse reads at most. */
  window: number;
}): string | null {
  if (input.type === "all" || input.matching > 0) return null;
  const scopes: readonly string[] = LORE_CONTRACT.vocabularies.memoryScopes;
  const label = `“${typeLabel(input.type)}”`;
  const memories = `No ${scopes.includes(input.type) ? `untyped ${label}` : label} Memories`;
  if (input.complete) return `${memories}.`;
  if (input.capped) return `${memories} in the first ${input.window.toLocaleString("en-US")}.`;
  if (input.stopped) return `${memories} among those loaded.`;
  return `${memories} have loaded yet.`;
}
