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

// WHICH EXTENSIONS ARE A PAGE — spelled once, here, and exported, because three
// places were answering it and one of them answered differently. `isMarkdown`
// (the import route's filter) and `NOTE_EXT` (the slug/ref stripper) were the
// same regex written twice in this file, and pipeline.ts's markdown-link parser
// had a third spelling that accepted only `md`. So `Other.markdown` imported as a
// page, `[[Notes/Other.markdown]]` linked to it, and `[Other](Notes/Other.markdown)`
// produced NO ref at all — no edge, no pending_links row, and nothing in
// list_broken_links either, because a ref that was never extracted cannot be
// reported broken. Silently invisible is the worst of the three outcomes.
export const NOTE_EXT = /\.(md|markdown)$/i;

// A markdown file becomes a page; anything else in the vault is an attachment
// we do not store.
export function isMarkdown(path: string): boolean {
  return NOTE_EXT.test(path);
}

// --- one name, one slug ------------------------------------------------------
//
// There is exactly ONE definition of "the slug this name means", and both readers
// of that question go through it: the importer naming a vault FILE, and the store
// reading the ADDRESS a path-shaped [[ref]] names (refAddress below). Two
// definitions is precisely what made maps/dated-note and maps/dated_note share one
// address — the store folded '-' and '_' to spaces on BOTH sides, so its predicate
// was "folds to that path" rather than "is that path", and whichever of the two
// real files was written first answered a ref that named the other.

// Noise a path-shaped name carries that says nothing about where the page is.
// Logseq/Foam emit './' and '../' (relative Markdown links are resolved against
// the referring page BEFORE they reach here — pipeline.ts mdTargetToRef), and
// Docusaurus/mkdocs write root-relative links ([Note](/maps/note.md)). Keeping a
// leading '/' left an empty first segment, which no page can ever have, so every
// root-relative link was unsatisfiable by construction.
const LEADING_NOISE = /^(?:\.{1,2}\/|\/)+/;
// Characters lore's slug rule forbids, plus the ones that make a slug ambiguous
// inside a wikilink. ONE source expression, two uses below (delete them from a
// filename / refuse to address by them), so the class cannot drift.
const FORBIDDEN = /[[\]|#?%<>:"\\^{}]/;
const FORBIDDEN_ALL = new RegExp(FORBIDDEN.source, "g");

// The folds that RENAME nothing: every character survives in some form. Case,
// Unicode compatibility form, the quotes normalizeRef also strips, and whitespace
// as a word separator. Kept separate from the deleting step below because
// refAddress has to know whether canonicalizing would DELETE a character.
function foldSegment(seg: string): string {
  return seg
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, "-");
}

function slugSegment(seg: string): string {
  return foldSegment(seg)
    .replace(FORBIDDEN_ALL, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugPath(path: string): string {
  return path
    .replace(LEADING_NOISE, "")
    .replace(NOTE_EXT, "")
    .split("/")
    .filter(Boolean)
    .map(slugSegment)
    .join("/");
}

// Vault path -> slug. Folders are kept (they are how a vault expresses
// hierarchy) and the filename is slugified, so "Projects/My Note.md" becomes
// "projects/my-note" — which the basename resolution arm then matches against
// a ref typed [[My Note]], and which refAddress reproduces exactly from a ref
// typed [[Projects/My Note]].
export function pathToSlug(path: string): string {
  // A Windows directory picker hands back backslashes; a vault path uses '/'.
  return slugPath(path.replace(/\\/g, "/"));
}

// The slug a path-shaped ref ADDRESSES — or null when the ref contains no
// separator and is therefore a NAME, which any page answering to it may satisfy.
//
// The ref goes through the SAME transform that named the page in the first place,
// which is the entire point: a space becomes a hyphen (so [[Maps/Dated Note]] still
// finds maps/dated-note — the headline case, and it must keep working) while an
// underscore stays an underscore, so maps/dated_note is a DIFFERENT address. The
// page's stored slug is compared as WRITTEN, never folded, so at most one page can
// be at an address and write order can never pick a winner.
//
// Returns "" — an address no page can be at, since a slug is never empty — rather
// than null when canonicalizing would DELETE a character. Deleting one forges a
// name the ref never spelled ("me%mory/vault/x" becomes "memory/vault/x"), and
// callers upstream screen the ref's RAW spelling (mcp.ts's reserved-namespace
// door). Returning null there would be worse than returning a wrong address,
// because null means name-shaped and hands the ref to the title, basename and
// alias arms — which assert no location at all.
//
// A '\' is NOT a separator here, unlike in a filesystem path: inside a ref it is a
// legal filename character, and reading it as one would make [[a\b]] address a page
// that a caller screening the raw ref never sees as a path.
export function refAddress(ref: string): string | null {
  const path = ref.normalize("NFKC").replace(LEADING_NOISE, "").replace(NOTE_EXT, "");
  if (!path.includes("/")) return null;
  const segs = path.split("/").filter(Boolean);
  if (segs.some((seg) => FORBIDDEN.test(foldSegment(seg)))) return "";
  // Assembled here rather than by calling slugPath(path): the strips above have
  // already run, and slugPath would run NOTE_EXT a second time — so "a/x.md.md"
  // would lose both extensions here while pathToSlug loses one, and the file and
  // the ref would stop agreeing. Every SEGMENT still goes through slugSegment.
  return segs.map(slugSegment).join("/");
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

// ORDER IS THE WHOLE BUG HERE. This used to strip ` # comment` FIRST and only
// then look for quotes, so a `#` INSIDE a quoted value was read as the start of a
// comment: the writer quotes `Design # notes` (correctly — `#` is not in its safe
// set), and the reader cut it back to `"Design`, quote and all. A quoted scalar
// has no comment inside it, so the quote has to be recognized before anything is
// cut. Unquoted values keep the comment rule, which is what it is for.
//
// Stripping ONE layer, not chaining: `"'x'"` is the VALUE `'x'`, and the chained
// form used to hand back `x`.
function scalar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"')) {
    let out = "";
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "\\" && i + 1 < t.length) {
        out += t[++i];
        continue;
      }
      if (t[i] === '"') return out.trim();
      out += t[i];
    }
    // Unterminated: fall through and keep the raw string. Not a YAML parser, and
    // this module's rule is that an unparseable value survives rather than
    // silently becoming something else.
  } else if (t.startsWith("'")) {
    const end = t.indexOf("'", 1);
    if (end !== -1) return t.slice(1, end).trim();
  }
  return t.replace(/\s+#\s.*$/, "").trim();
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
