// Turning vault files into pages. Pure functions only — the importer runs the
// file reading in the BROWSER (a directory picker), so nothing here may touch a
// filesystem: Workers has none.

export interface VaultFile {
  path: string;
  text: string;
}

export interface ParsedNote {
  slug: string;
  title?: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

// A markdown file becomes a page; anything else in the vault is an attachment
// we do not store.
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

// Vault path -> slug. Folders are kept (they are how a vault expresses
// hierarchy) and the filename is slugified, so "Projects/My Note.md" becomes
// "projects/my-note" — which the basename resolution arm then matches against
// a ref typed [[My Note]].
export function pathToSlug(path: string): string {
  const trimmed = path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\.(md|markdown)$/i, "");
  return trimmed
    .split("/")
    .filter(Boolean)
    .map((seg) =>
      seg
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, "-")
        // Characters lore's slug rule forbids, plus the ones that make a slug
        // ambiguous in a wikilink.
        .replace(/[[\]|#?%<>:"\\^{}]/g, "")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("/");
}

// The frontmatter subset Obsidian actually writes: scalars, inline arrays, and
// block arrays. Deliberately NOT a YAML implementation — no anchors, no nested
// maps, no multi-line scalars. An unparseable value is kept as its raw string
// rather than dropped, so nothing silently disappears.
// ponytail: ~40 lines beats a YAML dependency in the browser bundle; if real
// vaults turn out to need nested maps, that is when to reach for a parser.
export function parseFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { frontmatter: {}, body: text.replace(/^\uFEFF/, "") };
  const fm: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  let key: string | null = null;
  let block: string[] | null = null;
  const flush = () => {
    if (key && block) fm[key] = block;
    block = null;
  };
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      block ??= [];
      block.push(scalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.\- ]+):[ \t]*(.*)$/);
    if (!kv) continue;
    flush();
    key = kv[1].trim();
    const raw = kv[2].trim();
    if (raw === "") continue; // a block array may follow
    fm[key] = raw.startsWith("[") && raw.endsWith("]") ? inlineArray(raw) : scalar(raw);
  }
  flush();
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

function scalar(raw: string): string {
  return raw
    .replace(/\s+#\s.*$/, "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .trim();
}

function inlineArray(raw: string): string[] {
  return raw
    .slice(1, -1)
    .split(",")
    .map((s) => scalar(s))
    .filter(Boolean);
}

// A vault file -> the page to write. The title comes from frontmatter, else the
// H1, else the filename (store.putPage derives that last one itself).
export function parseNote(file: VaultFile): ParsedNote {
  const { frontmatter, body } = parseFrontmatter(file.text);
  const fmTitle = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fileTitle = (file.path.split("/").pop() ?? "").replace(/\.(md|markdown)$/i, "");
  return {
    slug: pathToSlug(file.path),
    title: fmTitle || heading || fileTitle || undefined,
    body,
    frontmatter,
  };
}
