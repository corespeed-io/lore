"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import {
  keepsBrowserClick,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
  revealHidden,
} from "@/modules/memories/browser/markdown";

interface MemoryMarkdownProps {
  content: string;
  /** Visible Memory ids by Memory Reference; a reference missing here stays inert. */
  wikilinkTargets: Readonly<Record<string, string>>;
  /** Why an inert wikilink did not resolve, since "not found" needs a complete Graph read. */
  unresolvedTitle: string;
  onOpen: (memoryId: string) => void;
}

/**
 * A Memory body rendered by markdown-it (see `markdown.ts`), whose output escapes
 * every character of the body, so it is set as the element's HTML. A body parses
 * once per content; a Graph refresh only renders it again. A resolved wikilink
 * routes in the client unless the click belongs to the browser.
 */
export default function MemoryMarkdown({
  content,
  wikilinkTargets,
  unresolvedTitle,
  onOpen,
}: MemoryMarkdownProps) {
  const tokens = useMemo(() => parseMemoryMarkdown(content), [content]);
  const html = useMemo(
    () => tokens && renderMemoryMarkdown(tokens, wikilinkTargets, unresolvedTitle),
    [tokens, wikilinkTargets, unresolvedTitle],
  );
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || html === null) return;
    element.innerHTML = html;
    const open = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a.wl") : null;
      const memoryId = link instanceof HTMLElement ? link.dataset.memoryId : undefined;
      if (!memoryId || keepsBrowserClick(event)) return;
      event.preventDefault();
      onOpen(memoryId);
    };
    element.addEventListener("click", open);
    return () => element.removeEventListener("click", open);
  }, [html, onOpen]);

  if (html === null) return <p className="detail-plain">{revealHidden(content)}</p>;
  return <div ref={body} className="detail-markdown" />;
}
