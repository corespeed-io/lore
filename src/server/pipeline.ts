// Write-path helpers: deterministic chunking, zero-LLM wikilink extraction,
// and the embeddings client. No DB access here — pure functions plus one fetch.

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// Paragraph-accumulating splitter targeting ~1200 chars (≈400 tokens). Memories
// are usually a single chunk; oversized paragraphs get hard-split.
export function chunkBody(body: string, target = 1200): string[] {
  const paras = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > target) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > target * 2) {
      out.push(cur.slice(0, target));
      cur = cur.slice(target);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// One normalizer, used on BOTH sides of every link comparison. A mismatch here
// makes stored keys silently unmatchable with no error anywhere, so nothing may
// compare refs without going through this.
export function normalizeRef(ref: string): string {
  return ref
    .normalize("NFKC")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// The basename arm's half of a two-sided comparison: filenames use hyphens or
// underscores where a ref is typed with spaces. Mirrors the SQL expression on
// pages.basename -- change one and you must change the other, or the arm
// silently matches nothing.
export function normalizeSlugish(ref: string): string {
  return normalizeRef(ref).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

// Blank out fenced blocks and inline code spans, preserving length so nothing
// downstream sees shifted offsets. A note documenting `[[example]]` syntax must
// not grow an edge the author cannot find in their prose.
function maskCode(body: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return body.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
}

const WIKILINK = /(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
// [text](target) — Obsidian's Markdown-link mode, and what Logseq/Foam export.
// The target runs to the closing paren rather than to the first space, because
// real files contain BOTH "Maps/Reading MOC.md" and the %20-encoded form; an
// optional "title" is stripped afterwards.
const MDLINK = /\[[^\]\n]*\]\(([^)\n]+)\)/g;

function addRef(refs: Set<string>, raw: string): void {
  const ref = raw.trim();
  if (ref) refs.add(ref);
}

// Turn a Markdown-link target into a page ref, or null if it isn't one:
// external URLs, mailto, in-page anchors, and non-markdown files (images,
// PDFs) are not pages.
function mdTargetToRef(raw: string): string | null {
  // Drop an optional link title: [x](path "Title")
  const target = raw.replace(/\s+["'(].*$/, "").trim();
  if (!target) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  if (target.startsWith("#")) return null;
  // Relative prefixes are noise: ../Maps/Note.md names the same page as
  // Maps/Note.md. Obsidian's Markdown mode and Logseq/Foam exports emit these.
  const path = decodeURIComponent(target.split("#")[0].replace(/^(?:\.{1,2}\/)+/, ""));
  if (!path) return null;
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (ext && ext !== "md") return null;
  return ext ? path.slice(0, -(ext.length + 1)) : path;
}

// Every way a page can point at another page: [[wikilinks]] (with #section and
// |alias), Markdown links, and both of those inside frontmatter values — real
// vaults put structure in Properties (`up: "[[MOC]]"`, `related: ["[[A]]"]`),
// and a body-only extractor imports those notes as edgeless dots.
// `![[embed]]` and `![](img.png)` are attachments, not links.
// ponytail: a Markdown link whose TEXT contains a wikilink yields both refs;
// they dedupe when they resolve to the same page, and are genuinely two
// references when they don't. Not worth span-tracking machinery.
export function extractRefs(body: string, frontmatter?: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const scan = (text: string) => {
    const masked = maskCode(text);
    for (const m of masked.matchAll(WIKILINK)) if (!m[1]) addRef(refs, m[2]);
    for (const m of masked.matchAll(MDLINK)) {
      const ref = mdTargetToRef(m[1]);
      // An image embed is written ![alt](img.png); the ! is outside our match,
      // so check the char before it.
      const at = m.index ?? 0;
      if (ref && masked[at - 1] !== "!") addRef(refs, ref);
    }
  };
  scan(body);
  for (const value of stringLeaves(frontmatter)) scan(value);
  return [...refs];
}

// Walk a frontmatter object's string leaves (arrays and nested objects
// included) so `up: "[[MOC]]"` and `related: ["[[A]]", "[[B]]"]` both count.
function stringLeaves(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => stringLeaves(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((v) =>
      stringLeaves(v, depth + 1),
    );
  }
  return [];
}

// Frontmatter `aliases` is the other name a page answers to — Obsidian writes
// it as a string or a list. Normalized on the way in so the stored keys and
// every lookup agree.
export function frontmatterAliases(frontmatter?: Record<string, unknown>): string[] {
  const raw = frontmatter?.aliases ?? frontmatter?.alias;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const out = new Set<string>();
  for (const a of list) if (typeof a === "string" && a.trim()) out.add(normalizeRef(a));
  return [...out];
}

export interface EmbeddingsConfig {
  url: string;
  apiKey: string;
  model: string;
  dim: number;
}

export function embeddingsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig {
  return {
    url: env.EMBEDDINGS_URL ?? "",
    apiKey: env.EMBEDDINGS_API_KEY ?? "",
    model: env.EMBEDDINGS_MODEL ?? "unconfigured",
    dim: Number(env.EMBEDDINGS_DIM ?? 1536),
  };
}

// OpenAI-compatible /embeddings client. Fails loud on misconfig — a write that
// can't embed must not half-land (the store only writes after embedding).
export function makeEmbedFn(cfg: EmbeddingsConfig): EmbedFn {
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    if (!cfg.url || !cfg.apiKey) {
      throw new Error(
        "embeddings not configured: set EMBEDDINGS_URL, EMBEDDINGS_API_KEY, EMBEDDINGS_MODEL, EMBEDDINGS_DIM",
      );
    }
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, input: texts, dimensions: cfg.dim }),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}`);
    const json = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error("embeddings response shape mismatch");
    }
    // Providers may reorder; index is authoritative when present.
    const out: number[][] = new Array(texts.length);
    data.forEach((d, i) => {
      out[d.index ?? i] = d.embedding;
    });
    for (const v of out) {
      if (!Array.isArray(v) || v.length !== cfg.dim) {
        throw new Error(`embeddings dim mismatch: got ${v?.length}, expected ${cfg.dim}`);
      }
    }
    return out;
  };
}
