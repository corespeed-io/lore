import MarkdownIt, { type Env, type StateInline, type Token } from "markdown-it";
import cjkFriendly from "markdown-it-cjk-friendly";

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

/**
 * Characters that would make the text a reader sees differ from the text an agent
 * reads: the bidirectional embedding, override, and isolate controls and the
 * left-to-right, right-to-left, and Arabic letter marks, which reorder what follows
 * them (a right-to-left mark draws "100 250" as "250 100"), and the Unicode tag
 * characters, which show as nothing. Right-to-left text that uses the marks shows
 * them too, the cost of a reader seeing numbers in the order an agent wrote. The only
 * tags a reader sees are the three subdivision flags (England, Scotland, and Wales),
 * which are matched first and kept; any other tag run, flag-shaped or not, shows.
 */
const HIDDEN_CHARACTERS =
  /\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}|[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

/** Text with each hidden control shown as a marker that names it, such as `⟨U+202E⟩`. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, (match) => {
    if (match.codePointAt(0) === 0x1f3f4) return match;
    const code = match.codePointAt(0) ?? 0;
    return `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}

/**
 * Whether text shows anything: a character other than a space or a zero-width
 * format character, once hidden controls have grown into their markers.
 */
export function hasVisibleText(text: string): boolean {
  return /[^\s\p{Cf}]/u.test(revealHidden(text));
}

/** Whether text ends in an odd run of backslashes, whose last one escapes what follows. */
function escapesNext(text: string): boolean {
  let run = 0;
  while (text[text.length - 1 - run] === "\\") run += 1;
  return run % 2 === 1;
}

function wikilink(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5b) {
    return false;
  }
  WIKILINK.lastIndex = state.pos;
  const match = WIKILINK.exec(state.src);
  if (!match || match.index + match[0].length > state.posMax) return false;
  const [, target = "", written] = match;
  // A backslash before `]]` escapes the bracket, so there is no wikilink.
  if (escapesNext(written ?? target)) return false;
  // A table cell needs the label's pipe escaped (`\|`). markdown-it unescapes it in
  // the cell, but a wikilink copied from a table into prose still carries the backslash.
  const reference = (
    written !== undefined && escapesNext(target) ? target.slice(0, -1) : target
  ).trim();
  if (!reference || !hasVisibleText(reference)) return false;
  if (!silent) {
    const label = written?.trim() ?? "";
    const token = state.push("wikilink", "", 0);
    token.meta = { reference, label: hasVisibleText(label) ? label : reference };
  }
  state.pos += match[0].length;
  return true;
}

/**
 * The only link targets a Memory body renders: http(s) with a host and no userinfo,
 * or mailto. Anything else, including `javascript:`, `data:`, a relative path, an
 * `https:/path` without a host, a `user@` before the host, or a percent escape in it
 * (either can make the shown URL name a host the link does not go to), stays text.
 * A host written outside ASCII, and a mailto link written with anything outside
 * ASCII or a percent escape, never reach this check: `normalizeLink` below refuses
 * them first.
 */
export function allowedHref(url: string): boolean {
  return /^(?:https?:\/\/[^\s/\\?#@%]+(?:[/?#]|$)|mailto:\S)/i.test(url);
}

/**
 * The Memory Markdown parser: CommonMark plus tables and strikethrough. Raw HTML,
 * bare URLs, and reference definitions stay text, a single line break stays a line
 * break, and `[[reference]]` becomes a `wikilink` token before links or emphasis can
 * claim its brackets. Emphasis follows the CJK-friendly amendment, so `**注意：**请`
 * is bold as `**Note:** read` is in English. With `html: false`, every character of the body
 * reaches the page escaped, so its HTML is safe to set as `innerHTML`.
 */
const memoryMarkdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
  maxNesting: MAXIMUM_MARKDOWN_NESTING,
}).use(cjkFriendly);
memoryMarkdown.validateLink = allowedHref;
// An autolink shows its URL as written. markdown-it would show punycode hosts and
// percent escapes decoded, so a reader could see a host the link does not go to.
memoryMarkdown.normalizeLinkText = (url) => url;
// A host written outside ASCII goes where its punycode points, which can read as
// another host (`github.com∕x.attacker.dev`), so such a link stays text. A mailto URL
// names addresses past a `/` and in `?to=` or `?cc=` too, and a mail client decodes
// its percent escapes, so a mailto link opens only when written wholly in ASCII with
// no percent escape. The check reads the URL trimmed, as markdown-it's own parse
// does, so leading Unicode whitespace cannot move the host out of its reach.
const normalizeLink = memoryMarkdown.normalizeLink.bind(memoryMarkdown);
// No `i` flag: under `iu`, \P{ASCII} matches `s` and `k` too, since ſ and K fold to them.
const SPOOFABLE_TARGET =
  /^(?:[A-Za-z][\w+.-]*:\/\/[^/?#]*\P{ASCII}|[Mm][Aa][Ii][Ll][Tt][Oo]:[\s\S]*[%\P{ASCII}])/u;
memoryMarkdown.normalizeLink = (url) =>
  SPOOFABLE_TARGET.test(url.trim()) ? "" : normalizeLink(url);
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

// `__rules__` is markdown-it's internal rule list; nothing public returns a rule by
// name. A release that renames it fails here, and so every test, rather than quietly.
const tableRule = memoryMarkdown.block.ruler.__rules__.find((rule) => rule.name === "table");
if (!tableRule) throw new Error("markdown-it has no table rule to bound");
const table = tableRule.fn;
/**
 * markdown-it's table rule, held to `MAXIMUM_TABLE_CELLS` across one body. The rule
 * fills in every cell a short row leaves out, so a 32,000-character body could
 * otherwise parse to millions of cells before the budget could drop them. A table is
 * parsed no further than one row past what is left of the budget; the table that
 * goes past it, and every later table, stays paragraph text.
 */
memoryMarkdown.block.ruler.at(
  "table",
  (state, startLine, endLine, silent) => {
    const env = state.env as MemoryEnv;
    if (env.tablesOff) return false;
    // Silently, markdown-it checks only the header and delimiter lines.
    if (!table(state, startLine, endLine, true)) return false;
    if (silent) return true;
    const delimiter = startLine + 1;
    const row = state.src.slice(
      state.bMarks[delimiter] + state.tShift[delimiter],
      state.eMarks[delimiter],
    );
    const columns = row.split("|").filter((cell) => cell.trim()).length;
    const rows = Math.floor((MAXIMUM_TABLE_CELLS - (env.tableCells ?? 0)) / Math.max(columns, 1));
    if (rows < 1) {
      env.tablesOff = true;
      return false;
    }
    const start = state.tokens.length;
    // Rows count from the header, so this stop parses one body row past the budget.
    if (!table(state, startLine, Math.min(endLine, startLine + 2 + rows), false)) return false;
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
  },
  { alt: [...tableRule.alt] },
);

const { escapeHtml } = memoryMarkdown.utils;
const rules = memoryMarkdown.renderer.rules;

/** A new tab for the web, the mail client in place for mailto; titles show on hover. */
function linkAttributes(href: string, title: string | number | null): string {
  const hover = title ? ` title="${escapeHtml(String(title))}"` : "";
  const tab = /^mailto:/i.test(href) ? "" : ' target="_blank" rel="noopener noreferrer"';
  return ` class="ext" href="${escapeHtml(href)}"${hover}${tab}`;
}

function insideAnchor(env: MemoryEnv): boolean {
  return env.anchors?.includes(true) ?? false;
}

/**
 * Whether the link opened at `index` shows any words before it closes. A wikilink
 * never sits in a link label: markdown-it refuses a label that holds one.
 */
function linkShowsText(tokens: readonly Token[], index: number): boolean {
  for (let next = index + 1; next < tokens.length; next += 1) {
    const token = tokens[next] as Token;
    if (token.type === "link_close") return false;
    const words = token.type === "image" ? altText(token.children ?? []) : token.content;
    if (hasVisibleText(words)) return true;
  }
  return false;
}

// One anchor at a time: an autolink in a link label renders as text. So does a link
// whose target markdown-it could not parse, since an empty one skips `validateLink`.
// A link with no words of its own shows its target, so it is never an empty anchor.
rules.link_open = (tokens, index, _options, env) => {
  const memory = env as MemoryEnv;
  const token = tokens[index] as Token;
  const href = String(token.attrGet("href") ?? "");
  const open = !insideAnchor(memory) && allowedHref(href);
  memory.anchors?.push(open);
  if (!open) return "";
  const target = linkShowsText(tokens, index) ? "" : escapeHtml(href);
  return `<a${linkAttributes(href, token.attrGet("title"))}>${target}`;
};
rules.link_close = (_tokens, _index, _options, env) =>
  (env as MemoryEnv).anchors?.pop() ? "</a>" : "";

/**
 * An image's alt text as it reads. markdown-it's own `renderInlineAsText` skips
 * wikilinks and strikethrough, which would lose a label or read struck words as
 * current, so this keeps each wikilink's label and each strike's `~~`.
 */
function altText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "image":
          return altText(token.children ?? []);
        case "wikilink":
          return String(token.meta?.label ?? "");
        case "s_open":
        case "s_close":
          return "~~";
        case "softbreak":
        case "hardbreak":
          return " ";
        default:
          return token.content;
      }
    })
    .join("");
}

// An image is a link to its source, never a remote load; inside a link, its words.
rules.image = (tokens, index, _options, env) => {
  const token = tokens[index] as Token;
  const alt = altText(token.children ?? []);
  const src = String(token.attrGet("src") ?? "");
  if (insideAnchor(env as MemoryEnv) || !allowedHref(src)) return escapeHtml(alt);
  const text = hasVisibleText(alt) ? alt : src;
  return `<a${linkAttributes(src, token.attrGet("title"))}>${escapeHtml(text)}</a>`;
};

rules.wikilink = (tokens, index, _options, env) => {
  const memory = env as MemoryEnv;
  const { reference, label } = (tokens[index] as Token).meta as {
    reference: string;
    label: string;
  };
  const shown = escapeHtml(label);
  // Unreachable while markdown-it refuses a link label holding a wikilink; kept so
  // anchors could never nest if it stopped.
  if (insideAnchor(memory)) return shown;
  // Only the map's own properties are targets, so a name like `constructor` is none.
  const targets = memory.targets ?? {};
  const target: unknown = Object.hasOwn(targets, reference) ? targets[reference] : undefined;
  const memoryId = typeof target === "string" && target ? target : undefined;
  const referenceText = escapeHtml(reference);
  if (!memoryId) {
    // The reference shows on hover, as a link's target does.
    const title = `${referenceText} — ${escapeHtml(memory.unresolvedTitle ?? "")}`;
    return `<span class="wl-unresolved" title="${title}">${shown}</span>`;
  }
  const hover = label === reference ? "" : ` title="${referenceText}"`;
  const href = `/memory/${encodeURIComponent(memoryId)}`;
  return `<a class="wl" href="${escapeHtml(href)}" data-memory-id="${escapeHtml(memoryId)}"${hover}>${shown}</a>`;
};

// A fence's info string shows above its code.
function fence(content: string, info: string): string {
  const caption = info ? `<span class="fence-info">${escapeHtml(info)}</span>` : "";
  return `<pre class="fence">${caption}<code>${escapeHtml(content)}</code></pre>\n`;
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

/**
 * A parsed body as HTML, with its wikilinks resolved against the visible Graph and
 * every hidden control, in text or an attribute, shown as its marker. A marker holds
 * no character HTML escapes, so revealing the HTML reveals every text in it.
 */
export function renderMemoryMarkdown(
  tokens: Token[],
  targets: Readonly<Record<string, string>>,
  unresolvedTitle: string,
): string {
  const env: MemoryEnv = { targets, unresolvedTitle, anchors: [] };
  return revealHidden(memoryMarkdown.renderer.render(tokens, memoryMarkdown.options, env));
}

const ESCAPED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"' };

/**
 * The words a rendering shows. Every character of the text reaches the HTML
 * escaped, so each tag is a rule's own and goes whole, attributes and all; a
 * strike keeps its `~~`, so struck words never read as current.
 */
function renderedWords(html: string): string {
  return html
    .replace(/<\/?s>/g, "~~")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot);/g, (_match, name: string) => ESCAPED[name] ?? "");
}

/**
 * A line's inline tokens. A heading's markers are block syntax, so a line that may be
 * one parses as a block, and a one-line heading reads as its text.
 */
function inlineTokens(markdown: string): Token[] {
  if (/^ {0,3}#/.test(markdown)) {
    const tokens = memoryMarkdown.parse(markdown, {});
    if (tokens.length === 3 && tokens[0]?.type === "heading_open") return [tokens[1] as Token];
  }
  return memoryMarkdown.parseInline(markdown, {});
}

/**
 * Inline Markdown as the words Memory detail would show for it, for titles and Graph
 * labels: the same parser and rules, so a title never drops a character the body
 * shows, nor keeps markup the body renders.
 */
export function plainInline(markdown: string): string {
  return renderedWords(renderMemoryMarkdown(inlineTokens(markdown), {}, ""));
}

/** A search snippet shows this many characters. */
const SNIPPET_LIMIT = 200;
/** A snippet parses this much of its source, enough to find the characters it shows. */
const SNIPPET_SOURCE_LIMIT = 2_000;

/** At most `limit` code units of text, never cutting a character outside the BMP in two. */
export function prefix(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[limit - 1] ?? "") ? limit - 1 : limit);
}

/**
 * A search snippet: a Memory's text as Memory detail shows it, whitespace collapsed,
 * code included, since search evidence is one chunk that may start inside a fence,
 * whose closing line then opens one.
 */
export function plain(markdown: string): string {
  const source = prefix(markdown, SNIPPET_SOURCE_LIMIT);
  const tokens = parseMemoryMarkdown(source);
  if (tokens) {
    // A fence's code reads on its own, without the info string shown above it.
    for (const token of tokens) if (token.type === "fence") token.info = "";
  }
  const words = tokens ? renderedWords(renderMemoryMarkdown(tokens, {}, "")) : revealHidden(source);
  return prefix(words.replace(/\s+/g, " ").trim(), SNIPPET_LIMIT);
}

/** The parts of a click that decide whether the page or the browser handles it. */
type LinkClick = Pick<
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
