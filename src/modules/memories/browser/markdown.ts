import MarkdownIt, { type StateInline, type Token } from "markdown-it";

/**
 * How deep blocks and inline markup may nest before markdown-it stops nesting:
 * its own default, named because a body that reaches it renders as text.
 */
export const MAXIMUM_MARKDOWN_NESTING = 100;
/** The cells one body's tables may render together; a table past them shows as its source. */
export const MAXIMUM_TABLE_CELLS = 5_000;

/**
 * `[[reference]]` or `[[reference|label]]` at the parser's position. Sticky, so a
 * body full of `[[` is matched in place instead of copying the rest of the text at
 * each one, and neither part may contain `[`, so a run of brackets fails at once.
 */
const WIKILINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]/y;

function wikilink(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5b) {
    return false;
  }
  WIKILINK.lastIndex = state.pos;
  const match = WIKILINK.exec(state.src);
  if (!match || match.index + match[0].length > state.posMax) return false;
  // In a table cell the label's pipe is written `\|`, which leaves the backslash here.
  const reference = match[1]?.replace(/\\$/, "").trim();
  if (!reference) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.meta = { reference, label: match[2]?.trim() || reference };
  }
  state.pos += match[0].length;
  return true;
}

/**
 * The only link targets a Memory body renders: http(s) with a host, or mailto.
 * Anything else, including `javascript:`, `data:`, a relative path, or an
 * `https:/path` without a host, stays plain text.
 */
export function allowedHref(url: string): boolean {
  return /^(?:https?:\/\/[^\s/\\?#]|mailto:\S)/i.test(url);
}

/**
 * The Memory Markdown parser: CommonMark plus tables and strikethrough. Raw HTML
 * stays text, bare URLs stay text, a single line break stays a line break, and
 * `[[reference]]` becomes a `wikilink` token before links or emphasis can claim
 * its brackets. Every rule it runs is linear in the input.
 */
export const memoryMarkdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
  maxNesting: MAXIMUM_MARKDOWN_NESTING,
});
memoryMarkdown.validateLink = allowedHref;
memoryMarkdown.inline.ruler.before("link", "wikilink", wikilink);

/**
 * A Memory body's tokens, or null when its blocks nest past the bound. A quote or
 * list item opened at the last level parses nothing inside it, so markdown-it
 * would drop the rest of that block; such a body shows as its text instead.
 */
export function parseMemoryMarkdown(content: string): Token[] | null {
  const tokens = memoryMarkdown.parse(content, {});
  const dropsText = tokens.some(
    (token) =>
      (token.type === "blockquote_open" || token.type === "list_item_open") &&
      token.level >= MAXIMUM_MARKDOWN_NESTING - 1,
  );
  return dropsText ? null : tokens;
}

/** Where the table opened at `start` closes, and how many cells it holds. */
export function tableExtent(
  tokens: readonly Token[],
  start: number,
): { end: number; cells: number } {
  let cells = 0;
  for (let index = start + 1; index < tokens.length; index += 1) {
    const type = tokens[index]?.type;
    if (type === "td_open" || type === "th_open") cells += 1;
    if (type === "table_close") return { end: index, cells };
  }
  return { end: tokens.length - 1, cells };
}

/** The Memory id a reference resolves to, read only from the map's own properties. */
export function wikilinkTarget(
  targets: Readonly<Record<string, string>>,
  reference: string,
): string | undefined {
  if (!Object.hasOwn(targets, reference)) return undefined;
  const target: unknown = targets[reference];
  return typeof target === "string" && target ? target : undefined;
}
