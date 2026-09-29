import type { Memory } from "@corespeed/lore-sdk";
import {
  hasVisibleText,
  memoryInlineText,
  memoryPlainText,
  revealHidden,
} from "@/modules/memories/browser/markdown";

export { hasVisibleText, revealHidden };

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  // Never cut between the two halves of a character outside the Basic Multilingual Plane.
  const end = /[\uD800-\uDBFF]/.test(text[limit - 2] ?? "") ? limit - 2 : limit - 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

const TITLE_LIMIT = 96;
/** A title reads at most this much of a first line, which may be the whole 32k body. */
const TITLE_SOURCE_LIMIT = 1_000;
/** A search snippet shows 200 characters; this much of its source is enough to find them. */
const SNIPPET_SOURCE_LIMIT = 2_000;

/**
 * Text with its inline Markdown reduced to the words Memory detail shows for it, for
 * places that show plain text: link and image text, wikilink labels, and code without
 * its backticks. The body's own parser and rules do this (`memoryInlineText`), after a
 * leading heading marker goes. Hidden controls show as markers.
 */
export function plainInline(text: string): string {
  return memoryInlineText(text.replace(/^#{1,6}[ \t]+/, ""));
}

/** Search snippets: a Memory's text as Memory detail shows it, without code blocks. */
export function plain(s: string): string {
  return memoryPlainText((s ?? "").slice(0, SNIPPET_SOURCE_LIMIT))
    .replace(/\s+/g, " ")
    .trim();
}

function configuredTitle(memory: Memory): string | null {
  const configured = memory.metadata.title;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

/** A text's first line. The split stops there, however long the body. */
function firstLine(text: string): string {
  return text.split(/\r\n?|\n/, 1)[0] ?? "";
}

function titleText(line: string): string {
  return plainInline(line.slice(0, TITLE_SOURCE_LIMIT));
}

/** A configured title as its words, or as written when its words show nothing. */
function shownTitle(source: string, limit: number): string {
  const words = compact(plainInline(source), limit);
  return hasVisibleText(words) ? words : compact(revealHidden(source), limit);
}

/** The title a row, label, or link shows, cut at the title limit. */
export function memoryTitle(memory: Memory): string {
  const configured = configuredTitle(memory);
  // Metadata may hold a title of 100,000 characters; only the first ones can show.
  if (configured !== null) return shownTitle(configured.slice(0, TITLE_SOURCE_LIMIT), TITLE_LIMIT);
  const title = compact(titleText(firstLine(memory.content)), TITLE_LIMIT);
  return hasVisibleText(title) ? title : "Untitled memory";
}

/**
 * The title Memory detail shows: a configured one whole, since no other part of the
 * page shows it, and a first-line one as rows do, since its line stays in the body
 * whenever the title cuts it short.
 */
export function memoryDetailTitle(memory: Memory): string {
  const configured = configuredTitle(memory);
  return configured === null
    ? memoryTitle(memory)
    : shownTitle(configured, Number.POSITIVE_INFINITY);
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
  /^(?:[ \t]*$|[ \t]{0,3}(?:[-*+][ \t]+\S|1[.)][ \t]|#{1,6}(?:[ \t]|$)|>)|\p{L}|\p{N}(?!\p{N}*[.)]))/u;

/**
 * The content Memory detail renders under its title. When a first line written as
 * a title is nothing but the words the title shows, and the next line opens a block
 * of its own, the body starts after that line rather than repeating it. Anything
 * else keeps the line, since the source view is one click away but a dropped line
 * is gone from the page.
 */
export function memoryBody(memory: Memory): string {
  const line = firstLine(memory.content);
  if (configuredTitle(memory) !== null || !TITLE_START.test(line)) return memory.content;
  const words = line.replace(/^#{1,6}[ \t]+/, "").replace(/^\*\*([^*\n]+)\*\*/, "$1");
  if (line.length > TITLE_SOURCE_LIMIT || MARKUP.test(words)) return memory.content;
  // Measured as the title shows it, with any hidden control grown into its marker.
  if (titleText(line).replace(/\s+/g, " ").trim().length > TITLE_LIMIT) return memory.content;
  const rest = memory.content.slice(line.length).replace(/^(?:\r\n?|\n)/, "");
  // An ATX heading always ends at its line; any other title line could continue.
  if (!line.startsWith("#") && !OPENS_BLOCK.test(firstLine(rest))) return memory.content;
  return rest.replace(/^(?:\r\n?|\n)+/, "");
}

/**
 * The `metadata.type` a Memory actually carries, hidden controls as markers, or
 * null when it has none. Every type chip, badge, and breakdown reads it here.
 */
export function memoryConfiguredType(memory: Memory): string | null {
  const configured = memory.metadata.type;
  return typeof configured === "string" && configured.trim()
    ? revealHidden(configured.trim())
    : null;
}

/** The `metadata.source` a Memory names, hidden controls as markers, or null. */
export function memorySource(memory: Memory): string | null {
  const source = memory.metadata.source;
  return typeof source === "string" && source.trim() ? revealHidden(source.trim()) : null;
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
