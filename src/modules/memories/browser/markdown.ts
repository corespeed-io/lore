const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (character) => ESC[character]);
}

export function plain(s: string): string {
  return (s ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#*`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Wikilink {
  reference: string;
  label: string;
}

/** Inline markup within one line of escaped text; no tag spans a line break. */
function inline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\s])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a class="ext" href="$2" target="_blank" rel="noopener">$1</a>',
    );
}

const MAXIMUM_LIST_DEPTH = 3;

/**
 * Block structure of escaped text. A blank line ends a paragraph, and a single
 * line break inside one is kept as `<br>`, since Memories are notes whose line
 * breaks carry meaning. Headings, list items (indented two spaces per level),
 * and fenced code stand on their own lines.
 */
function blocks(escaped: string): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  for (const line of escaped.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^([ \t]*)[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      endParagraph();
    } else if (heading) {
      endParagraph();
      html.push(`<h3>${inline(heading[1] ?? "")}</h3>`);
    } else if (item) {
      endParagraph();
      const indent = (item[1] ?? "").replace(/\t/g, "  ").length;
      const depth = Math.min(Math.floor(indent / 2), MAXIMUM_LIST_DEPTH);
      html.push(`<span class="li${depth ? ` li-${depth}` : ""}">${inline(item[2] ?? "")}</span>`);
    } else if (/^\s*@@FENCE\d+@@\s*$/.test(line)) {
      endParagraph();
      html.push(line.trim());
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  return html.join("");
}

/**
 * `unresolvedTitle` explains an inert wikilink. Callers pass a different reason
 * while the Graph that resolves references is loading, failed, or capped, since
 * "not found" is only true once a complete Graph read says so.
 */
export function renderMarkdown(
  md: string,
  wikilinkTargets: Readonly<Record<string, string>> = {},
  unresolvedTitle = "Memory reference not found",
): string {
  const fences: string[] = [];
  const withoutFences = (md ?? "").replace(/```([\s\S]*?)```/g, (_m, c) => {
    fences.push(c);
    return `@@FENCE${fences.length - 1}@@`;
  });
  const wikilinks: Wikilink[] = [];
  const stashed = withoutFences.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g,
    (_match, rawReference: string, rawLabel: string | undefined) => {
      const reference = rawReference.trim();
      wikilinks.push({ reference, label: rawLabel?.trim() || reference });
      return `@@WIKILINK${wikilinks.length - 1}@@`;
    },
  );
  let h = blocks(esc(stashed));
  h = h.replace(/@@WIKILINK(\d+)@@/g, (_match, rawIndex: string) => {
    const wikilink = wikilinks[Number(rawIndex)];
    if (!wikilink) return "";
    const targetMemoryId = Object.hasOwn(wikilinkTargets, wikilink.reference)
      ? wikilinkTargets[wikilink.reference]
      : undefined;
    if (typeof targetMemoryId !== "string" || !targetMemoryId) {
      return `<span class="wl-unresolved" data-reference="${esc(wikilink.reference)}" title="${esc(unresolvedTitle)}">${esc(wikilink.label)}</span>`;
    }
    return `<a class="wl" href="/memory/${encodeURIComponent(targetMemoryId)}" data-memory-id="${esc(targetMemoryId)}" data-reference="${esc(wikilink.reference)}">${esc(wikilink.label)}</a>`;
  });
  h = h.replace(/@@FENCE(\d+)@@/g, (_m, i) => `<pre class="fence">${esc(fences[+i])}</pre>`);
  return h;
}
