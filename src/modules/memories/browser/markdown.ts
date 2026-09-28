import MarkdownIt, { type Env, type StateBlock, type StateInline, type Token } from "markdown-it";

/**
 * How deep blocks and inline markup may nest before markdown-it stops nesting:
 * its own default, named because a body that reaches it renders as text.
 */
export const MAXIMUM_MARKDOWN_NESTING = 100;
/** The cells one body's tables may hold together; a table past them stays paragraph text. */
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
  // A table cell needs the label's pipe escaped (`\|`). markdown-it unescapes it in
  // the cell, but a wikilink copied from a table into prose still carries the backslash.
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
 * The Memory Markdown parser: CommonMark plus tables and strikethrough, without
 * reference definitions. Raw HTML stays text, bare URLs stay text, a single line
 * break stays a line break, and
 * `[[reference]]` becomes a `wikilink` token before links or emphasis can claim
 * its brackets. Every rule it runs is linear in the input, and the tables of one
 * body hold at most `MAXIMUM_TABLE_CELLS` cells (see `boundedTable`).
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
// A reference definition renders as nothing, so text an agent wrote there would be
// invisible to the human reading Memory detail. Without the rule it stays text.
memoryMarkdown.block.ruler.disable("reference");

/** What one body's parse has spent of `MAXIMUM_TABLE_CELLS`. */
interface TableBudget extends Env {
  tableCells?: number;
  tablesOff?: boolean;
}

type BlockRule = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

/**
 * markdown-it's table rule, held to `MAXIMUM_TABLE_CELLS` across one body. The rule
 * fills in every cell a short row leaves out, so without the bound a 32,000-character
 * body parses to millions of cells before anything renders. The first table past the
 * budget is parsed once and dropped; it and every later table stay paragraph text.
 */
function boundedTable(table: BlockRule): BlockRule {
  return (state, startLine, endLine, silent) => {
    const budget = state.env as TableBudget;
    if (budget.tablesOff) return false;
    if (silent) return table(state, startLine, endLine, true);
    const start = state.tokens.length;
    if (!table(state, startLine, endLine, false)) return false;
    let cells = budget.tableCells ?? 0;
    for (let index = start; index < state.tokens.length; index += 1) {
      const type = state.tokens[index]?.type;
      if (type === "td_open" || type === "th_open") cells += 1;
    }
    if (cells > MAXIMUM_TABLE_CELLS) {
      state.tokens.length = start;
      state.line = startLine;
      budget.tablesOff = true;
      return false;
    }
    budget.tableCells = cells;
    return true;
  };
}

const tableRule = memoryMarkdown.block.ruler.__rules__.find((rule) => rule.name === "table");
if (!tableRule) throw new Error("markdown-it has no table rule to bound");
memoryMarkdown.block.ruler.at("table", boundedTable(tableRule.fn), { alt: [...tableRule.alt] });

/** How deep an inline token stream nests, counting the images inside image labels. */
function inlineDepth(tokens: readonly Token[]): number {
  let depth = 0;
  let deepest = 0;
  for (const token of tokens) {
    depth += token.nesting;
    const inner = token.type === "image" ? depth + 1 + inlineDepth(token.children ?? []) : depth;
    deepest = Math.max(deepest, inner);
  }
  return deepest;
}

/**
 * A Memory body's tokens, or null when it nests past `MAXIMUM_MARKDOWN_NESTING`,
 * and such a body shows as its text instead. A quote or list item opened at the
 * last block level parses nothing inside it, so markdown-it would drop the rest of
 * that block. Emphasis pairs after the bound applies, so inline markup is measured
 * here: without that, a body of nested `*a _a` could render thousands of elements deep.
 */
export function parseMemoryMarkdown(content: string): Token[] | null {
  const budget: TableBudget = {};
  const tokens = memoryMarkdown.parse(content, budget);
  for (const token of tokens) {
    if (token.level >= MAXIMUM_MARKDOWN_NESTING - 1 && token.nesting === 1) {
      if (token.type === "blockquote_open" || token.type === "list_item_open") return null;
    }
    if (token.children && token.level + inlineDepth(token.children) > MAXIMUM_MARKDOWN_NESTING) {
      return null;
    }
  }
  return tokens;
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
