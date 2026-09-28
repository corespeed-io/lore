import type { Memory } from "@corespeed/lore-sdk";

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  // Never cut between the two halves of a character outside the Basic Multilingual Plane.
  const end = /[\uD800-\uDBFF]/.test(text[limit - 2] ?? "") ? limit - 2 : limit - 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Characters that would make the text a reader sees differ from the text an agent
 * reads: the bidirectional embedding, override, and isolate controls, which reorder
 * what follows them, and the Unicode tag characters, which show as nothing. The one
 * use of tags a reader sees, an emoji flag's tag sequence, is matched first and kept.
 */
const HIDDEN_CHARACTERS =
  /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,6}\u{E007F}|[\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

/** Text with each hidden control shown as a marker that names it, such as `⟨U+202E⟩`. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, (match) => {
    if (match.codePointAt(0) === 0x1f3f4) return match;
    const code = match.codePointAt(0) ?? 0;
    return `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}

const TITLE_LIMIT = 96;
/** A title reads at most this much of a first line, which may be the whole 32k body. */
const TITLE_SOURCE_LIMIT = 1_000;

/**
 * A link target that Memory detail renders: http(s) or mailto, optionally in angle
 * brackets, with one level of parentheses inside it and an optional quoted title.
 * Its alternatives start with different characters, so it never backtracks far.
 */
const LINK_TARGET = String.raw`\(<?(?:https?:\/\/|mailto:)(?:[^()\s<>]|\([^()\s]*\))*>?(?:\s+"[^"\n]*")?\)`;
const IMAGE = new RegExp(String.raw`!\[([^[\]\n]*)\]${LINK_TARGET}`, "g");
const LINK = new RegExp(String.raw`\[([^[\]\n]+)\]${LINK_TARGET}`, "g");

/**
 * Text with the inline Markdown that Memory detail renders reduced to its words,
 * for places that show plain text: a leading heading marker, wikilinks, links and
 * images, bold, and emphasis. Code spans keep their text as written, and so does
 * strikethrough, whose markers are the only sign the words are struck. A backslash
 * escape reads as the character it escapes, and so do `&amp;`, `&lt;`, `&gt;`,
 * `&quot;`, and numeric entities; other named entities stay as written. Every `**`
 * goes, paired or not, because a label cut short may keep only the opening one, but
 * one with space on both sides is text. An underscore inside a word is never
 * emphasis. Hidden controls show as markers (`revealHidden`). No pattern can match
 * `[` inside brackets, so a run of brackets costs linear time.
 */
export function plainInline(text: string): string {
  const code: string[] = [];
  const stash = (kept: string) => `\u0000${code.push(kept) - 1}\u0000`;
  return revealHidden(
    text
      .replace(/`([^`\n]+)`/g, (_match, span: string) => stash(span))
      .replace(/\\([!-/:-@[-`{-~])/g, (_match, character: string) => stash(character))
      .replace(
        /&(amp|lt|gt|quot|#(\d{1,7})|#[xX]([\da-fA-F]{1,6}));/g,
        (match, name: string, decimal: string | undefined, hex: string | undefined) =>
          stash(entity(match, name, decimal, hex)),
      )
      .replace(/^#{1,6}[ \t]+/, "")
      .replace(/\[\[([^[\]|\n]+)\|([^[\]\n]+)\]\]/g, "$2")
      .replace(/\[\[([^[\]\n]+)\]\]/g, "$1")
      .replace(IMAGE, "$1")
      .replace(LINK, "$1")
      // A `**` with space on both sides is text, not a marker.
      .replace(/(?<!\s)\*\*|\*\*(?!\s)/g, "")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]+)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([^_\n]+)__(?![\p{L}\p{N}_])/gu, "$1$2")
      .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1$2")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Memory text never holds NUL, so NUL marks what was stashed.
      .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? ""),
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

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"' };

function entity(match: string, name: string, decimal?: string, hex?: string): string {
  const code = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : null;
  if (code === null) return ENTITIES[name] ?? match;
  // Only a Unicode scalar value that is not NUL, as CommonMark decodes it.
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    ? String.fromCodePoint(code)
    : "\ufffd";
}

function configuredTitle(memory: Memory): string | null {
  const configured = memory.metadata.title;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

function count(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** A text's first line. The split stops there, however long the body. */
function firstLine(text: string): string {
  return text.split(/\r\n?|\n/, 1)[0] ?? "";
}

function titleText(line: string): string {
  return plainInline(line.slice(0, TITLE_SOURCE_LIMIT));
}

export function memoryTitle(memory: Memory): string {
  const configured = configuredTitle(memory);
  if (configured !== null) {
    // Metadata may hold a title of 100,000 characters; only the first ones can show.
    const source = configured.slice(0, TITLE_SOURCE_LIMIT);
    return compact(plainInline(source), TITLE_LIMIT) || compact(source, TITLE_LIMIT);
  }
  return compact(titleText(firstLine(memory.content)), TITLE_LIMIT) || "Untitled memory";
}

/** A first line written as a title: it opens with a heading, a bold run, or a 【…】 run. */
const TITLE_START = /^(?:#{1,6}[ \t]|\*\*[^*\n]+\*\*|__[^_\n]+__|(?:\*\*)?【[^】\n]+】)/;
/**
 * Markup a title cannot carry: a link or autolink, which only the body can follow,
 * and strikethrough, escapes, or entities, whose plain text reads differently.
 */
const BODY_ONLY_MARKUP = /\[[^[\]]*\]|<[^<>]*>|~~|\\|&/;

/**
 * Whether the line after a title line would parse differently once the title line
 * is gone. The title line is a paragraph, so the next line may be its continuation:
 * a table delimiter or setext underline that makes it a header or heading, or text
 * that alone would open an indented code block or a list that cannot interrupt a
 * paragraph (an empty item, or a number other than 1). Each
 * test is a trim, a split, or an anchored pattern with no ambiguous repetition.
 */
function continuesTitle(next: string): boolean {
  const text = next.trim();
  if (!text) return false;
  if (/^(?: {0,3}\t| {4})/.test(next)) return true;
  if (/^=+$/.test(text) || /^[*+]$/.test(text)) return true;
  const ordered = /^(\d{1,9})[.)](?:\s|$)/.exec(text);
  if (ordered && (Number(ordered[1]) !== 1 || /^\d+[.)]$/.test(text))) return true;
  const cells = text.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/**
 * The content Memory detail renders under its title. When the title shows the
 * whole of a first line written as a title, the body starts after that line
 * rather than repeating it. The line stays whenever the page would otherwise lose
 * something: when the title cuts it short, when it holds markup only the body can
 * show, when the next line would parse differently without it, and when it is a
 * plain line that may open a paragraph.
 */
export function memoryBody(memory: Memory): string {
  const line = firstLine(memory.content);
  if (configuredTitle(memory) !== null || !TITLE_START.test(line)) return memory.content;
  if (line.length > TITLE_SOURCE_LIMIT || BODY_ONLY_MARKUP.test(line)) return memory.content;
  // An odd backtick opens a code span the next line continues, and an odd `**` is text;
  // either way the title cannot stand for the line.
  if (count(line, "`") % 2 === 1 || count(line, "**") % 2 === 1) return memory.content;
  const title = titleText(line).replace(/\s+/g, " ").trim();
  if (title.length > TITLE_LIMIT || title.includes("*")) return memory.content;
  const rest = memory.content.slice(line.length).replace(/^(?:\r\n?|\n)/, "");
  // An ATX heading always ends at its line; any other title line can be continued.
  if (!/^#{1,6}[ \t]/.test(line) && continuesTitle(firstLine(rest))) return memory.content;
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
