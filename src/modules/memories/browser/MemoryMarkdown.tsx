"use client";

import { createContext, createElement, type ReactNode, use, useMemo } from "react";
import {
  keepsBrowserClick,
  type MarkdownNode,
  memoryMarkdownTree,
  wikilinkView,
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

function Wikilink({ reference, label }: { reference: string; label: string }) {
  const { targets, unresolvedTitle, onOpen } = use(WikilinkContext);
  const view = wikilinkView(targets, reference, label, unresolvedTitle);
  const { memoryId } = view;
  if (memoryId === undefined) {
    return (
      <span className="wl-unresolved" title={view.title}>
        {label}
      </span>
    );
  }
  return (
    <a
      className="wl"
      href={view.href}
      title={view.title}
      onClick={(event) => {
        if (keepsBrowserClick(event)) return;
        event.preventDefault();
        onOpen(memoryId);
      }}
    >
      {label}
    </a>
  );
}

/** React elements for a tree whose tags and attributes `markdown.ts` already fixed. */
function elements(nodes: readonly MarkdownNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (typeof node === "string") return node;
    if (node.kind === "wikilink") {
      // biome-ignore lint/suspicious/noArrayIndexKey: a body's tree is rebuilt only when its content changes, and never reorders.
      return <Wikilink key={index} reference={node.reference} label={node.label} />;
    }
    const children = node.children.length ? [elements(node.children)] : [];
    return createElement(node.tag, { key: index, ...node.props }, ...children);
  });
}

/**
 * A Memory body as CommonMark plus tables and strikethrough, parsed by markdown-it
 * and rendered as React elements, so no body HTML reaches the page. Every decision
 * about what renders is a pure function in `markdown.ts`: `memoryMarkdownTree` for
 * the body, which shows as its text when it cannot render whole, and `wikilinkView`
 * for wikilinks, which resolve against the Graph at render time.
 */
export default function MemoryMarkdown({
  content,
  wikilinkTargets,
  unresolvedTitle,
  onOpen,
}: MemoryMarkdownProps) {
  const body = useMemo(() => {
    const tree = memoryMarkdownTree(content);
    return tree ? elements(tree) : <p className="detail-plain">{content}</p>;
  }, [content]);
  const wikilinks = useMemo(
    () => ({ targets: wikilinkTargets, unresolvedTitle, onOpen }),
    [wikilinkTargets, unresolvedTitle, onOpen],
  );
  return <WikilinkContext value={wikilinks}>{body}</WikilinkContext>;
}
