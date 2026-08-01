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

// Splits on commas that are OUTSIDE quotes. A naive split(",") let one value
// become several across an export -> import round trip: the writer correctly
// quotes `["doe, jane"]`, and re-reading it produced two aliases. That is not
// cosmetic — the same trick on `related_ids` MINTS A GRAPH EDGE the author never
// wrote, and on `aliases` it mints a resolution arm, so a crafted title could
// make an unrelated page answer to a name.
function inlineArray(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (quote) {
      // Backslash escapes only inside double quotes, matching the writer.
      if (c === "\\" && quote === '"' && i + 1 < raw.length - 1) {
        cur += raw[++i];
        continue;
      }
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  // scalar() still runs for comment-stripping and stray-quote tolerance on
  // values that were never quoted in the first place.
  return out.map((s) => scalar(s)).filter(Boolean);
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
