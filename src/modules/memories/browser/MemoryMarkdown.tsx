"use client";

import type { Token } from "markdown-it";
import { createContext, Fragment, type MouseEvent, type ReactNode, use, useMemo } from "react";
import {
  allowedHref,
  MAXIMUM_TABLE_CELLS,
  parseMemoryMarkdown,
  tableExtent,
  wikilinkTarget,
} from "@/modules/memories/browser/markdown";

interface Wikilinks {
  /** Visible Memory ids by Memory Reference; a reference missing here stays inert. */
  targets: Readonly<Record<string, string>>;
  /** Why an inert wikilink did not resolve, since "not found" needs a complete Graph read. */
  unresolvedTitle: string;
  onOpen: (memoryId: string) => void;
}

interface MemoryMarkdownProps {
  content: string;
  wikilinkTargets: Wikilinks["targets"];
  unresolvedTitle: string;
  onOpen: Wikilinks["onOpen"];
}

/** Only wikilinks read Graph state, so a Graph refresh re-renders them and not the body. */
const WikilinkContext = createContext<Wikilinks>({
  targets: {},
  unresolvedTitle: "",
  onOpen: () => {},
});

/** A click the browser should keep: modified, not the main button, or already handled. */
function keepsBrowserClick(event: MouseEvent): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function Wikilink({ reference, label }: { reference: string; label: string }) {
  const { targets, unresolvedTitle, onOpen } = use(WikilinkContext);
  const target = wikilinkTarget(targets, reference);
  if (!target) {
    return (
      <span className="wl-unresolved" data-reference={reference} title={unresolvedTitle}>
        {label}
      </span>
    );
  }
  return (
    <a
      className="wl"
      href={`/memory/${encodeURIComponent(target)}`}
      data-memory-id={target}
      data-reference={reference}
      onClick={(event) => {
        if (keepsBrowserClick(event)) return;
        event.preventDefault();
        onOpen(target);
      }}
    >
      {label}
    </a>
  );
}

/** Headings sit under the page's own title, so `#` and `##` render as `<h3>`. */
const HEADINGS: Readonly<Record<string, "h3" | "h4" | "h5">> = {
  h1: "h3",
  h2: "h3",
  h3: "h4",
};

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (/^mailto:/i.test(href)) {
    return (
      <a className="ext" href={href}>
        {children}
      </a>
    );
  }
  return (
    <a className="ext" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function href(token: Token, name: "href" | "src"): string | null {
  const value = token.attrGet(name);
  return typeof value === "string" && allowedHref(value) ? value : null;
}

/** A table cell's `text-align`, as a class rather than an inline style. */
function alignment(token: Token): string | undefined {
  const align = /text-align:(left|center|right)/.exec(String(token.attrGet("style") ?? ""))?.[1];
  return align ? `align-${align}` : undefined;
}

/** The words an image's alt text or a link label carries, without its markup. */
function textOf(tokens: readonly Token[] | null): string {
  return (tokens ?? [])
    .map((token) => (token.type === "image" ? textOf(token.children) : token.content))
    .join("");
}

interface Frame {
  token: Token | null;
  key: number;
  children: ReactNode[];
}

function container({ token, key, children }: Frame): ReactNode {
  switch (token?.type) {
    case "paragraph_open":
      // A tight list keeps its paragraphs but does not show them as paragraphs.
      return token.hidden ? <Fragment key={key}>{children}</Fragment> : <p key={key}>{children}</p>;
    case "heading_open": {
      const Heading = HEADINGS[token.tag] ?? "h5";
      return <Heading key={key}>{children}</Heading>;
    }
    case "bullet_list_open":
      return <ul key={key}>{children}</ul>;
    case "ordered_list_open": {
      // markdown-it sets `start` only for a list that does not start at 1.
      const start = token.attrGet("start");
      return (
        <ol key={key} start={start === null ? undefined : Number(start)}>
          {children}
        </ol>
      );
    }
    case "list_item_open":
      return <li key={key}>{children}</li>;
    case "blockquote_open":
      return <blockquote key={key}>{children}</blockquote>;
    case "table_open":
      return <table key={key}>{children}</table>;
    case "thead_open":
      return <thead key={key}>{children}</thead>;
    case "tbody_open":
      return <tbody key={key}>{children}</tbody>;
    case "tr_open":
      return <tr key={key}>{children}</tr>;
    case "th_open":
      return (
        <th key={key} className={alignment(token)}>
          {children}
        </th>
      );
    case "td_open":
      return (
        <td key={key} className={alignment(token)}>
          {children}
        </td>
      );
    case "strong_open":
      return <strong key={key}>{children}</strong>;
    case "em_open":
      return <em key={key}>{children}</em>;
    case "s_open":
      return <s key={key}>{children}</s>;
    case "link_open": {
      const target = href(token, "href");
      return target ? (
        <ExternalLink key={key} href={target}>
          {children}
        </ExternalLink>
      ) : (
        <Fragment key={key}>{children}</Fragment>
      );
    }
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

/** What renders a table over the cell budget: its own lines, as written. */
interface Source {
  lines: readonly string[];
  cells: number;
}

function leaf(token: Token, key: number, inLink: boolean, source: Source): ReactNode {
  switch (token.type) {
    case "inline":
      return <Fragment key={key}>{render(token.children ?? [], source)}</Fragment>;
    case "text":
      return token.content;
    case "code_inline":
      return <code key={key}>{token.content}</code>;
    case "softbreak":
    case "hardbreak":
      return <br key={key} />;
    case "fence":
    case "code_block":
      return (
        <pre key={key} className="fence">
          <code>{token.content}</code>
        </pre>
      );
    case "hr":
      return <hr key={key} />;
    case "image": {
      // An image is a link to its source, never a remote load; inside a link, its words.
      const alt = textOf(token.children);
      const src = href(token, "src");
      if (inLink || !src) return alt;
      return (
        <ExternalLink key={key} href={src}>
          {alt || src}
        </ExternalLink>
      );
    }
    case "wikilink": {
      const reference = token.meta?.reference;
      const label = token.meta?.label;
      if (typeof reference !== "string" || typeof label !== "string") return null;
      return inLink ? label : <Wikilink key={key} reference={reference} label={label} />;
    }
    default:
      return token.content;
  }
}

/**
 * React elements for markdown-it's flat token stream, in one pass: an opening
 * token starts an element, its closing token finishes it. Only the element types
 * named in `container` and `leaf` render; anything else keeps just its text.
 */
function render(tokens: readonly Token[], source: Source): ReactNode[] {
  const stack: Frame[] = [{ token: null, key: -1, children: [] }];
  let links = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    const parent = stack[stack.length - 1] as Frame;
    if (token.nesting === 1) {
      if (token.type === "table_open") {
        const { end, cells } = tableExtent(tokens, index);
        if (cells > source.cells) {
          const [from, to] = token.map ?? [0, 0];
          parent.children.push(
            <pre key={index} className="fence">
              {source.lines.slice(from, to).join("\n")}
            </pre>,
          );
          index = end;
          continue;
        }
        source.cells -= cells;
      }
      if (token.type === "link_open") links += 1;
      stack.push({ token, key: index, children: [] });
    } else if (token.nesting === -1) {
      if (stack.length === 1) continue;
      const frame = stack.pop() as Frame;
      if (frame.token?.type === "link_open") links -= 1;
      (stack[stack.length - 1] as Frame).children.push(container(frame));
    } else {
      parent.children.push(leaf(token, index, links > 0, source));
    }
  }
  while (stack.length > 1) {
    const frame = stack.pop() as Frame;
    (stack[stack.length - 1] as Frame).children.push(container(frame));
  }
  return (stack[0] as Frame).children;
}

/**
 * A Memory body as CommonMark plus tables and strikethrough, parsed by markdown-it
 * and rendered as React elements, so no body HTML reaches the page. Raw HTML shows
 * as text, only http(s) and mailto links render, an image is a link to its source,
 * and the tables of one body share `MAXIMUM_TABLE_CELLS`. A body that nests past
 * the parser's bound shows as its text.
 */
export default function MemoryMarkdown({
  content,
  wikilinkTargets,
  unresolvedTitle,
  onOpen,
}: MemoryMarkdownProps) {
  const body = useMemo(() => {
    const tokens = parseMemoryMarkdown(content);
    if (!tokens) return <p className="detail-plain">{content}</p>;
    return render(tokens, {
      lines: content.replace(/\r\n?/g, "\n").split("\n"),
      cells: MAXIMUM_TABLE_CELLS,
    });
  }, [content]);
  const wikilinks = useMemo(
    () => ({ targets: wikilinkTargets, unresolvedTitle, onOpen }),
    [wikilinkTargets, unresolvedTitle, onOpen],
  );
  return <WikilinkContext value={wikilinks}>{body}</WikilinkContext>;
}
