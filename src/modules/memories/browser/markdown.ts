import MarkdownIt, { type Env, type StateBlock, type StateInline, type Token } from "markdown-it";
import { revealHidden } from "@/modules/memories/browser/presentation";

/**
 * How deep blocks and inline markup may nest before markdown-it stops nesting:
 * its own default, named because a body that reaches it renders as text.
 */
export const MAXIMUM_MARKDOWN_NESTING = 100;
/** The cells one body's tables may hold together; past them, tables stay text. */
export const MAXIMUM_TABLE_CELLS = 5_000;

/** What one parse and render of a body reads and records. */
interface MemoryEnv extends Env {
  targets?: Readonly<Record<string, string>>;
  unresolvedTitle?: string;
  /** For each open link, whether it rendered an anchor. */
  anchors?: boolean[];
  tableCells?: number;
  tablesOff?: boolean;
}

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
 * The Memory Markdown parser: CommonMark plus tables and strikethrough. Raw HTML,
 * bare URLs, and reference definitions stay text, a single line break stays a line
 * break, and `[[reference]]` becomes a `wikilink` token before links or emphasis can
 * claim its brackets. With `html: false`, every character of the body reaches the
 * page escaped, so its HTML is safe to set as `innerHTML`.
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
// A reference definition renders as nothing, which would hide what an agent wrote there.
memoryMarkdown.block.ruler.disable("reference");

/** Headings sit under the page's own `<h1>` title. */
const HEADINGS: Readonly<Record<string, string>> = { h1: "h2", h2: "h2", h3: "h3" };
memoryMarkdown.core.ruler.push("memory_headings", (state) => {
  for (const token of state.tokens) {
    if (token.type === "heading_open" || token.type === "heading_close") {
      token.tag = HEADINGS[token.tag] ?? "h4";
    }
  }
});

type BlockRule = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

/**
 * markdown-it's table rule, held to `MAXIMUM_TABLE_CELLS` across one body. The rule
 * fills in every cell a short row leaves out, so a 32,000-character body could
 * otherwise parse to millions of cells. The table that goes past the budget is
 * parsed once and dropped, and it and every later table stay paragraph text.
 */
function boundedTable(table: BlockRule): BlockRule {
  return (state, startLine, endLine, silent) => {
    const env = state.env as MemoryEnv;
    if (env.tablesOff) return false;
    if (silent) return table(state, startLine, endLine, true);
    const start = state.tokens.length;
    if (!table(state, startLine, endLine, false)) return false;
    let cells = env.tableCells ?? 0;
    for (let index = start; index < state.tokens.length; index += 1) {
      const type = state.tokens[index]?.type;
      if (type === "td_open" || type === "th_open") cells += 1;
    }
    if (cells > MAXIMUM_TABLE_CELLS) {
      state.tokens.length = start;
      state.line = startLine;
      env.tablesOff = true;
      return false;
    }
    env.tableCells = cells;
    return true;
  };
}

const tableRule = memoryMarkdown.block.ruler.__rules__.find((rule) => rule.name === "table");
if (!tableRule) throw new Error("markdown-it has no table rule to bound");
memoryMarkdown.block.ruler.at("table", boundedTable(tableRule.fn), { alt: [...tableRule.alt] });

const { escapeHtml } = memoryMarkdown.utils;
const rules = memoryMarkdown.renderer.rules;

/** A new tab for the web, the mail client in place for mailto; titles show on hover. */
function linkAttributes(href: string, title: string | number | null): string {
  const hover = title ? ` title="${escapeHtml(revealHidden(String(title)))}"` : "";
  const tab = /^mailto:/i.test(href) ? "" : ' target="_blank" rel="noopener noreferrer"';
  return ` class="ext" href="${escapeHtml(href)}"${hover}${tab}`;
}

function insideAnchor(env: MemoryEnv): boolean {
  return env.anchors?.includes(true) ?? false;
}

// One anchor at a time: an autolink in a link label renders as text. So does a link
// whose target markdown-it could not parse, since an empty one skips `validateLink`.
rules.link_open = (tokens, index, _options, env) => {
  const memory = env as MemoryEnv;
  const token = tokens[index] as Token;
  const href = String(token.attrGet("href") ?? "");
  const open = !insideAnchor(memory) && allowedHref(href);
  memory.anchors?.push(open);
  return open ? `<a${linkAttributes(href, token.attrGet("title"))}>` : "";
};
rules.link_close = (_tokens, _index, _options, env) =>
  (env as MemoryEnv).anchors?.pop() ? "</a>" : "";

// An image is a link to its source, never a remote load; inside a link, its words.
rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index] as Token;
  const alt = renderer.renderInlineAsText(token.children ?? [], options, env);
  const src = String(token.attrGet("src") ?? "");
  if (insideAnchor(env as MemoryEnv) || !allowedHref(src)) return escapeHtml(revealHidden(alt));
  const text = alt.trim() ? revealHidden(alt) : src;
  return `<a${linkAttributes(src, token.attrGet("title"))}>${escapeHtml(text)}</a>`;
};

rules.wikilink = (tokens, index, _options, env) => {
  const memory = env as MemoryEnv;
  const { reference, label } = (tokens[index] as Token).meta as {
    reference: string;
    label: string;
  };
  const shown = escapeHtml(revealHidden(label));
  if (insideAnchor(memory)) return shown;
  const memoryId = wikilinkTarget(memory.targets ?? {}, reference);
  const referenceText = escapeHtml(revealHidden(reference));
  if (!memoryId) {
    // The reference shows on hover, as a link's target does.
    const title = `${referenceText} — ${escapeHtml(memory.unresolvedTitle ?? "")}`;
    return `<span class="wl-unresolved" title="${title}">${shown}</span>`;
  }
  const hover = label === reference ? "" : ` title="${referenceText}"`;
  const href = `/memory/${encodeURIComponent(memoryId)}`;
  return `<a class="wl" href="${escapeHtml(href)}" data-memory-id="${escapeHtml(memoryId)}"${hover}>${shown}</a>`;
};

// Text, code, and a fence's info string (shown above its code) as they read.
rules.text = (tokens, index) => escapeHtml(revealHidden((tokens[index] as Token).content));
rules.code_inline = (tokens, index) =>
  `<code>${escapeHtml(revealHidden((tokens[index] as Token).content))}</code>`;
function fence(content: string, info: string): string {
  const caption = info ? `<span class="fence-info">${escapeHtml(revealHidden(info))}</span>` : "";
  return `<pre class="fence">${caption}<code>${escapeHtml(revealHidden(content))}</code></pre>\n`;
}
rules.fence = (tokens, index) => {
  const token = tokens[index] as Token;
  return fence(token.content, token.info.trim());
};
rules.code_block = (tokens, index) => fence((tokens[index] as Token).content, "");

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
 * that block; emphasis pairs after the bound applies, so inline depth is measured too.
 */
export function parseMemoryMarkdown(content: string): Token[] | null {
  const tokens = memoryMarkdown.parse(content, {} satisfies MemoryEnv);
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

/** A parsed body as HTML, with its wikilinks resolved against the visible Graph. */
export function renderMemoryMarkdown(
  tokens: Token[],
  targets: Readonly<Record<string, string>>,
  unresolvedTitle: string,
): string {
  const env: MemoryEnv = { targets, unresolvedTitle, anchors: [] };
  return memoryMarkdown.renderer.render(tokens, memoryMarkdown.options, env);
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

/** The parts of a click that decide whether the page or the browser handles it. */
export type LinkClick = Pick<
  MouseEvent,
  "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

/** A click the browser should keep: modified, not the main button, or already handled. */
export function keepsBrowserClick(click: LinkClick): boolean {
  return (
    click.defaultPrevented ||
    click.button !== 0 ||
    click.metaKey ||
    click.ctrlKey ||
    click.shiftKey ||
    click.altKey
  );
}
