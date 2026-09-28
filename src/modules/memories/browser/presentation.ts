import type { Memory } from "@corespeed/lore-sdk";

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

const TITLE_LIMIT = 96;
/** A title reads at most this much of a first line, which may be the whole 32k body. */
const TITLE_SOURCE_LIMIT = 1_000;

/**
 * Text with the inline Markdown that Memory detail renders reduced to its words,
 * for places that show plain text: a leading heading marker, wikilinks, links and
 * images, bold, strikethrough, and `*emphasis*`. Code spans keep their text as
 * written. Every `**` goes, paired or not, because a label cut short may keep only
 * the opening one. No pattern can match `[` inside brackets, so a run of brackets
 * costs linear time.
 */
export function plainInline(text: string): string {
  const code: string[] = [];
  return (
    text
      .replace(/`([^`\n]+)`/g, (_match, span: string) => `\u0000${code.push(span) - 1}\u0000`)
      .replace(/^#{1,6}\s+/, "")
      .replace(/\[\[([^[\]|\n]+)\|([^[\]\n]+)\]\]/g, "$2")
      .replace(/\[\[([^[\]\n]+)\]\]/g, "$1")
      .replace(/!\[([^[\]\n]*)\]\([^()\s]*\)/g, "$1")
      .replace(/\[([^[\]\n]+)\]\((?:https?:\/\/|mailto:)[^()\s]*\)/g, "$1")
      .replace(/\*\*|~~/g, "")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]+)\*(?!\w)/g, "$1$2")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Memory text never holds NUL, so NUL marks a code span.
      .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? "")
  );
}

/** Search snippets: a Memory's text without its fences, block markers, or inline markup. */
export function plain(s: string): string {
  return plainInline(
    (s ?? "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^[ \t]{0,3}(?:>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)+/gm, ""),
  )
    .replace(/[#*`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function configuredTitle(memory: Memory): string | null {
  const configured = memory.metadata.title;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

function lines(content: string): string[] {
  return content.split(/\r\n?|\n/);
}

function firstLine(memory: Memory): string {
  return lines(memory.content)[0] ?? "";
}

function titleText(line: string): string {
  return plainInline(line.slice(0, TITLE_SOURCE_LIMIT));
}

export function memoryTitle(memory: Memory): string {
  const configured = configuredTitle(memory);
  if (configured !== null) return compact(plainInline(configured), TITLE_LIMIT) || configured;
  return compact(titleText(firstLine(memory)), TITLE_LIMIT) || "Untitled memory";
}

/** A first line written as a title: it opens with a heading, a bold run, or a 【…】 run. */
const TITLE_START = /^(?:#{1,6}\s|\*\*[^*\n]+\*\*|(?:\*\*)?【[^】\n]+】)/;
/** A line that makes the one above it part of a table or a setext heading. */
const CONTINUES_FIRST_LINE = /^\s*(?:\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?|=+)\s*$/;

/**
 * The content Memory detail renders under its title. When the title shows the
 * whole of a first line written as a title, the body starts after that line
 * rather than repeating it. The line stays when the title cuts it short, when it
 * holds a link the title cannot follow, when the next line makes it a table row
 * or a setext heading, and when it is a plain line that may open a paragraph.
 */
export function memoryBody(memory: Memory): string {
  const line = firstLine(memory);
  if (configuredTitle(memory) !== null || !TITLE_START.test(line)) return memory.content;
  if (/\[\[|\]\(/.test(line)) return memory.content;
  if (titleText(line).replace(/\s+/g, " ").trim().length > TITLE_LIMIT) return memory.content;
  const rest = memory.content.slice(line.length).replace(/^(?:\r\n?|\n)/, "");
  // An ATX heading always ends at its line; any other title line can be continued.
  if (!/^#{1,6}\s/.test(line) && CONTINUES_FIRST_LINE.test(lines(rest)[0] ?? "")) {
    return memory.content;
  }
  return rest.replace(/^(?:\r\n?|\n)+/, "");
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
