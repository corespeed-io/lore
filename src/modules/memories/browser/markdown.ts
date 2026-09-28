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
  /** The line after the last table dropped for its cells; no table starts before it. */
  droppedUntil?: number;
}

type BlockRule = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

/**
 * How many cells markdown-it reads from a table row: its pipes that no backslash
 * escapes split it, and an empty cell before a leading pipe or after a trailing
 * one does not count. The same split as markdown-it's own `escapedSplit`.
 */
export function tableRowCells(line: string): number {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of line.trim()) {
    if (character === "|" && !escaped) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
    escaped = character === "\\";
  }
  cells.push(cell);
  if (cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells.length;
}

/** Whether a body row of the table just parsed holds more cells than its header. */
function dropsCells(state: StateBlock, start: number): boolean {
  let columns = 0;
  let body = false;
  for (let index = start; index < state.tokens.length; index += 1) {
    const token = state.tokens[index];
    if (token?.type === "th_open") columns += 1;
    if (token?.type === "tbody_open") body = true;
    if (body && token?.type === "tr_open" && token.map) {
      if (tableRowCells(lineText(state, token.map[0])) > columns) return true;
    }
  }
  return false;
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

/**
 * markdown-it's table rule, held to what Memory detail can show. The rule fills in
 * every cell a short row leaves out, so without a bound a 32,000-character body
 * parses to millions of cells before anything renders. Every table of one body,
 * kept or dropped, spends one `MAXIMUM_TABLE_CELLS` budget; a table is parsed no
 * further than one row past what is left of it, and the table that goes past it and
 * every later table stay paragraph text. The rule also silently drops the cells a
 * long row has past its header, so such a table stays paragraph text too, and no
 * text of the body goes unseen. markdown-it would then try a table again at each of
 * the dropped table's lines, so no table may start inside it: each row is parsed at
 * most once.
 */
function boundedTable(table: BlockRule): BlockRule {
  return (state, startLine, endLine, silent) => {
    const budget = state.env as TableBudget;
    if (budget.tablesOff || startLine < (budget.droppedUntil ?? 0)) return false;
    // Silently, markdown-it checks only the header and delimiter lines.
    if (!table(state, startLine, endLine, true)) return false;
    if (silent) return true;
    const spent = budget.tableCells ?? 0;
    const rowsLeft = Math.floor(
      (MAXIMUM_TABLE_CELLS - spent) / tableRowCells(lineText(state, startLine)),
    );
    if (rowsLeft < 1) {
      budget.tablesOff = true;
      return false;
    }
    // Rows start at the header; one row past the budget is enough to know it is over.
    const stop = Math.min(endLine, startLine + rowsLeft + 2);
    const start = state.tokens.length;
    if (!table(state, startLine, stop, false)) return false;
    let cells = spent;
    for (let index = start; index < state.tokens.length; index += 1) {
      const type = state.tokens[index]?.type;
      if (type === "td_open" || type === "th_open") cells += 1;
    }
    budget.tableCells = cells;
    const overBudget = cells > MAXIMUM_TABLE_CELLS;
    if (overBudget || dropsCells(state, start)) {
      budget.droppedUntil = state.line;
      state.tokens.length = start;
      state.line = startLine;
      if (cells >= MAXIMUM_TABLE_CELLS) budget.tablesOff = true;
      return false;
    }
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

/**
 * A character a reader can see: a letter, digit, punctuation, or symbol, but not one
 * a font draws as nothing (a default-ignorable one, such as the Hangul fillers, or a
 * blank Braille pattern).
 */
const VISIBLE = /(?![\p{Default_Ignorable_Code_Point}\u2800])[\p{L}\p{N}\p{P}\p{S}]/u;

/** Whether text shows anything, where spaces and zero-width characters show nothing. */
export function hasVisibleText(text: string): boolean {
  return VISIBLE.test(text);
}

/** The only elements a Memory body renders. */
export type MarkdownTag =
  | "p"
  | "h2"
  | "h3"
  | "h4"
  | "ul"
  | "ol"
  | "li"
  | "blockquote"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "strong"
  | "em"
  | "s"
  | "code"
  | "pre"
  | "span"
  | "a"
  | "br"
  | "hr";

/** The only attributes a Memory body renders. */
export interface MarkdownProps {
  className?: string;
  start?: number;
  href?: string;
  title?: string;
  target?: "_blank";
  rel?: "noopener noreferrer";
}

/**
 * A rendered Memory body without React: text, an element from the fixed tag and
 * attribute sets, or a wikilink the renderer resolves against the Graph.
 */
export type MarkdownNode =
  | string
  | { kind: "element"; tag: MarkdownTag; props: MarkdownProps; children: MarkdownNode[] }
  | { kind: "wikilink"; reference: string; label: string };

function element(tag: MarkdownTag, children: MarkdownNode[], props: MarkdownProps = {}) {
  return { kind: "element" as const, tag, props, children };
}

/** Headings sit under the page's own `<h1>` title, so `#` and `##` render as `<h2>`. */
const HEADINGS: Readonly<Record<string, MarkdownTag>> = { h1: "h2", h2: "h2", h3: "h3" };

/** Block and inline containers that render as one element of their own. */
const CONTAINERS: Readonly<Record<string, MarkdownTag>> = {
  bullet_list_open: "ul",
  list_item_open: "li",
  blockquote_open: "blockquote",
  table_open: "table",
  thead_open: "thead",
  tbody_open: "tbody",
  tr_open: "tr",
  th_open: "th",
  td_open: "td",
  strong_open: "strong",
  em_open: "em",
  s_open: "s",
};

function attribute(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return typeof value === "string" && value ? value : null;
}

function target(token: Token, name: "href" | "src"): string | null {
  const value = attribute(token, name);
  return value && allowedHref(value) ? value : null;
}

/** An external link: a new tab for the web, the mail client in place for mailto. */
function linkProps(href: string, title: string | null): MarkdownProps {
  const props: MarkdownProps = { className: "ext", href };
  if (title) props.title = title;
  if (!/^mailto:/i.test(href)) {
    props.target = "_blank";
    props.rel = "noopener noreferrer";
  }
  return props;
}

/** A table cell's `text-align`, as a class rather than an inline style. */
function alignment(token: Token): MarkdownProps {
  const align = /text-align:(left|center|right)/.exec(attribute(token, "style") ?? "")?.[1];
  return align ? { className: `align-${align}` } : {};
}

/** The words a run of nodes shows. */
export function nodeText(nodes: readonly MarkdownNode[]): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return node;
      return node.kind === "wikilink" ? node.label : nodeText(node.children);
    })
    .join("");
}

/**
 * An image's alt text as it reads. Alt text that holds an image, a link, or a
 * wikilink shows as written: flattened to words, it would hide their targets,
 * titles, and references, which only its source still carries.
 */
function altText(image: Token): string {
  const children = image.children ?? [];
  const nested = children.some(
    (child) => child.type === "image" || child.type === "link_open" || child.type === "wikilink",
  );
  if (nested) return image.content;
  return children
    .map((child) =>
      child.type === "softbreak" || child.type === "hardbreak" ? " " : child.content,
    )
    .join("");
}

function append(target: MarkdownNode[], nodes: readonly MarkdownNode[]): void {
  for (const node of nodes) target.push(node);
}

interface Frame {
  token: Token | null;
  children: MarkdownNode[];
  /** Opened inside a link, where another anchor would nest one anchor in another. */
  inLink: boolean;
}

/** What a finished container renders, as nodes for its parent. */
function closed({ token, children, inLink }: Frame): MarkdownNode[] {
  switch (token?.type) {
    case "paragraph_open":
      // A tight list keeps its paragraphs but does not show them as paragraphs.
      return token.hidden ? children : [element("p", children)];
    case "heading_open":
      return [element(HEADINGS[token.tag] ?? "h4", children)];
    case "ordered_list_open": {
      // markdown-it sets `start`, a number, only for a list that does not start at 1.
      const start = token.attrGet("start");
      return [element("ol", children, start === null ? {} : { start: Number(start) })];
    }
    case "link_open": {
      // markdown-it keeps links out of link labels, but not an autolink.
      const href = inLink ? null : target(token, "href");
      if (!href) return children;
      // A link that shows no text of its own shows its target.
      const shown = hasVisibleText(nodeText(children)) ? children : [href];
      return [element("a", shown, linkProps(href, attribute(token, "title")))];
    }
    default: {
      const tag = token ? CONTAINERS[token.type] : undefined;
      return tag && token ? [element(tag, children, alignment(token))] : children;
    }
  }
}

/** What a token with no children of its own renders. */
function leaf(token: Token, inLink: boolean): MarkdownNode[] {
  switch (token.type) {
    case "inline":
      return tree(token.children ?? []);
    case "code_inline":
      return [element("code", [token.content])];
    case "softbreak":
    case "hardbreak":
      return [element("br", [])];
    case "hr":
      return [element("hr", [])];
    case "fence":
    case "code_block": {
      // A fence's info string is text of the body too, so it shows above the code.
      const info = token.info.trim();
      const caption = info ? [element("span", [info], { className: "fence-info" })] : [];
      return [
        element("pre", [...caption, element("code", [token.content])], { className: "fence" }),
      ];
    }
    case "image": {
      // An image is a link to its source, never a remote load. Inside a link, where
      // it cannot be a link, its source shows on hover as a link's target does.
      const alt = altText(token);
      const src = target(token, "src");
      if (!src) return [alt];
      const title = attribute(token, "title");
      const shown = hasVisibleText(alt) ? alt : src;
      if (inLink) return [element("span", [shown], { title: title ? `${src} — ${title}` : src })];
      return [element("a", [shown], linkProps(src, title))];
    }
    case "wikilink": {
      const reference = token.meta?.reference;
      const label = token.meta?.label;
      if (typeof reference !== "string" || typeof label !== "string") return [];
      const shown = hasVisibleText(label) ? label : reference;
      return inLink ? [shown] : [{ kind: "wikilink", reference, label: shown }];
    }
    default:
      return token.content ? [token.content] : [];
  }
}

/**
 * markdown-it's flat token stream as a tree, in one pass: an opening token starts
 * a container and its closing token finishes it. Only the tags and attributes in
 * `MarkdownTag` and `MarkdownProps` render; anything else keeps just its text.
 */
function tree(tokens: readonly Token[]): MarkdownNode[] {
  const stack: Frame[] = [{ token: null, children: [], inLink: false }];
  let links = 0;
  for (const token of tokens) {
    const parent = stack[stack.length - 1] as Frame;
    if (token.nesting === 1) {
      stack.push({ token, children: [], inLink: links > 0 });
      if (token.type === "link_open") links += 1;
    } else if (token.nesting === -1) {
      if (stack.length === 1) continue;
      const frame = stack.pop() as Frame;
      if (frame.token?.type === "link_open") links -= 1;
      append((stack[stack.length - 1] as Frame).children, closed(frame));
    } else {
      append(parent.children, leaf(token, links > 0));
    }
  }
  while (stack.length > 1) {
    const frame = stack.pop() as Frame;
    append((stack[stack.length - 1] as Frame).children, closed(frame));
  }
  return (stack[0] as Frame).children;
}

/**
 * A Memory body as the tree Memory detail renders, or null when it must show as
 * its text (see `parseMemoryMarkdown`). Every rendering decision but a wikilink's
 * resolution (`wikilinkView`) lives here, so tests pin them without rendering React.
 */
export function memoryMarkdownTree(content: string): MarkdownNode[] | null {
  const tokens = parseMemoryMarkdown(content);
  return tokens && tree(tokens);
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

/** How a wikilink renders: a link to the Memory it resolves to, or inert text. */
export type WikilinkView =
  | { memoryId: string; href: string; title?: string }
  | { memoryId?: undefined; title: string };

/**
 * A resolved wikilink links to its Memory and names its reference on hover when the
 * label differs; an unresolved one names its reference and why it did not resolve,
 * as a link's target shows on hover.
 */
export function wikilinkView(
  targets: Readonly<Record<string, string>>,
  reference: string,
  label: string,
  unresolvedTitle: string,
): WikilinkView {
  const memoryId = wikilinkTarget(targets, reference);
  if (!memoryId) return { title: `${reference} — ${unresolvedTitle}` };
  const href = `/memory/${encodeURIComponent(memoryId)}`;
  return label === reference ? { memoryId, href } : { memoryId, href, title: reference };
}

/** The parts of a click that decide whether the page or the browser handles it. */
export interface LinkClick {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

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
