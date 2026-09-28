import type { Memory } from "@corespeed/lore-sdk";

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

const TITLE_LIMIT = 96;

/**
 * Text with the inline Markdown that Memory detail renders (bold, code spans,
 * links, wikilinks) reduced to its words, for places that show plain text. Every
 * `**` goes, paired or not, because a label cut short may keep only the opening one.
 */
export function plainInline(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`([^`\n]+)`/g, "$1");
}

function configuredTitle(memory: Memory): string | null {
  const configured = memory.metadata.title;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

function firstLine(memory: Memory): string {
  return memory.content.split(/\r?\n/, 1)[0] ?? memory.content;
}

function titleText(line: string): string {
  return plainInline(line.replace(/^#+\s*/, ""));
}

export function memoryTitle(memory: Memory): string {
  return (
    configuredTitle(memory) ??
    (compact(titleText(firstLine(memory)), TITLE_LIMIT) || "Untitled memory")
  );
}

/** A first line written as a title: it opens with a heading, a bold run, or a 【…】 run. */
const TITLE_START = /^(?:#{1,6}\s|\*\*[^*\n]+\*\*|(?:\*\*)?【[^】\n]+】)/;

/**
 * The content Memory detail renders under its title. When the title shows the
 * whole of a first line written as a title, the body starts after that line
 * rather than repeating it. A line the title cuts short stays, and so does a
 * plain first line, which may open a paragraph.
 */
export function memoryBody(memory: Memory): string {
  const line = firstLine(memory);
  if (configuredTitle(memory) !== null || !TITLE_START.test(line)) return memory.content;
  if (titleText(line).replace(/\s+/g, " ").trim().length > TITLE_LIMIT) return memory.content;
  return memory.content.slice(line.length).replace(/^(?:\r?\n)+/, "");
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
