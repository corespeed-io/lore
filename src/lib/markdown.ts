const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export function esc(s: string): string {
  return (s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
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

export function renderMarkdown(md: string): string {
  const fences: string[] = [];
  const stashed = (md ?? "").replace(/```([\s\S]*?)```/g, (_m, c) => {
    fences.push(c);
    return `@@FENCE${fences.length - 1}@@`;
  });
  let h = esc(stashed);
  h = h.replace(/^(#{1,6})\s+(.*)$/gm, (_m, _hashes, t) => `<h3>${t}</h3>`);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(^|[^*\s])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  h = h.replace(/^\s*[-*]\s+(.*)$/gm, '<span class="li">$1</span>');
  h = h.replace(
    /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
    (_m, slug, label) => `<a class="wl" data-slug="${esc(slug)}">${esc(label)}</a>`,
  );
  h = h.replace(
    /\[\[([^\]]+)\]\]/g,
    (_m, slug) => `<a class="wl" data-slug="${esc(slug)}">${esc(slug)}</a>`,
  );
  h = h.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a class="ext" href="$2" target="_blank" rel="noopener">$1</a>',
  );
  h = h.replace(/@@FENCE(\d+)@@/g, (_m, i) => `<pre class="fence">${esc(fences[+i])}</pre>`);
  return h;
}
