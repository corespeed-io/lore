// Write-path helpers: deterministic chunking, zero-LLM wikilink extraction,
// and the embeddings client. No DB access here — pure functions plus one fetch.

import { NOTE_EXT } from "./vault";

// The role is what the store knows and the embedder cannot infer. Every strong
// 2026 retrieval model is trained asymmetrically — the query carries a one-line
// task instruction, the document carries none — and a signature of
// (texts) => vectors has nowhere to say which side it is holding, so both went
// through unprefixed. Optional, and "document" by default: a model that wants no
// instruction (bge-m3) is unaffected, and so is a deployment that sets no prefix.
export type EmbedFn = (texts: string[], role?: "query" | "document") => Promise<number[][]>;

// A chunk is not just its text. `context` is the heading trail it sits under and
// `source` says whether it is prose or a code fence — both decide how it gets
// EMBEDDED without changing what gets STORED.
export interface Chunk {
  text: string;
  /** Heading trail, injected at embed time only. Empty for code. */
  context: string;
  source: "prose" | "code";
}

// Contextual retrieval, the way Anthropic published it and gbrain implements it:
// the wrapper is built JUST IN TIME at the embed call and NEVER persisted.
//
// That boundary is the whole trick. `chunks.text` is read by the trigram arm, by
// FTS, and by every search result's snippet — bake "Overview › Architecture"
// into it and you have polluted all three to help one. The embedding gets the
// context; the readers get what the author wrote.
//
// Code fences skip it (gbrain's D20-T4): prepending a markdown page's heading to
// a code block does not help cross-modal retrieval and spends embedding tokens
// to do it.
export function embedInput(c: Chunk): string {
  if (c.source === "code" || !c.context) return c.text;
  return `<context>\n${c.context}\n</context>\n${c.text}`;
}

// Structure-aware splitter targeting ~1200 chars (≈400 tokens). Memories are
// usually a single chunk.
//
// It used to accumulate paragraphs and `slice(0, target)` anything oversized,
// which is fine for a hand-written note and wrong for everything else. Measured
// on one real 6k-char pull request: of 5 chunks, TWO cut a ``` fence in half —
// so both halves are broken code, and the retrievable unit is a fragment nobody
// wrote — and two more ended mid-line, one of them slicing a mermaid diagram at
// `participant DB as MongoDB`. Documents that arrive from an importer are mostly
// this shape: markdown with fences, diffs, tables.
//
// Three rules, in order of how much damage they prevent:
//
//   1. NEVER split inside a fenced block. A fence is one unit however long it
//      is: half a code block embeds as noise and reads as garbage.
//   2. Prefer a heading boundary, and carry the heading PATH into each chunk.
//      A chunk that begins mid-document otherwise arrives with no idea what it
//      is about — the section title is exactly the context the embedding needs,
//      and it is free.
//   3. Split an oversized run at a line break, then a sentence end, then (last
//      resort) a hard slice. A cut between words costs a token the model then
//      has to guess at.
const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6}) +(.+?)\s*$/;

// Rule 1's ceiling. "A fence is one unit however long it is" was written for
// fences people write; a 78 KB fence (a pasted log, a vendored bundle) made a
// single chunk the embedding endpoint refuses — and putPage embeds BEFORE its
// transaction, so the page became unwritable through every door (put_page,
// /api/import, remember_note). 8,000 chars is ~2-3k tokens: far under any
// embedding context, and comfortably above every fence in the measured corpus
// (max ~2.2k), so real code blocks still embed whole and only the pathological
// ones split — at line boundaries, still as code.
const FENCE_CEILING = 8_000;

// Blocks that must not be broken: a fenced run is atomic, everything else is a
// paragraph. Also records the heading path each block sits under.
function blocksOf(body: string): { text: string; path: string[]; atomic: boolean }[] {
  const out: { text: string; path: string[]; atomic: boolean }[] = [];
  const path: string[] = [];
  const lines = body.split("\n");
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push({ text, path: [...path], atomic: false });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line.trim());
    if (fence) {
      flush();
      const marker = fence[1];
      const block = [line];
      // Consume to the closing marker. An UNTERMINATED fence — one stray ```
      // mid-document — used to consume to EOF as a single atomic unit, turning
      // the whole document tail into one context-less "code" chunk (measured:
      // a 36 KB tail). An unmatched marker is not a fence: the run falls back
      // to prose, keeping its heading context and the prose splitting rules.
      let closed = false;
      for (i++; i < lines.length; i++) {
        block.push(lines[i]);
        if (lines[i].trim().startsWith(marker)) {
          closed = true;
          break;
        }
      }
      out.push({ text: block.join("\n"), path: [...path], atomic: closed });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const depth = heading[1].length;
      path.length = Math.min(path.length, depth - 1);
      path[depth - 1] = heading[2];
      for (let d = 0; d < depth - 1; d++) path[d] ??= "";
      out.push({ text: line.trim(), path: [...path], atomic: false });
      continue;
    }
    if (!line.trim()) flush();
    else buf.push(line);
  }
  flush();
  return out;
}

// Break a too-long run on the best boundary available, never mid-word.
function softSplit(text: string, target: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > target * 2) {
    const window = rest.slice(0, target);
    const at =
      window.lastIndexOf("\n") > target * 0.4
        ? window.lastIndexOf("\n")
        : Math.max(window.lastIndexOf("。"), window.lastIndexOf(". "), window.lastIndexOf(" "));
    const cut = at > target * 0.3 ? at + 1 : target;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export function chunkBody(body: string, target = 1200): Chunk[] {
  const blocks = blocksOf(body);
  if (!blocks.length) return [];
  const out: Chunk[] = [];
  let cur = "";
  let curPath: string[] = [];

  const trail = (path: string[]) => path.filter(Boolean).join(" › ");
  const push = () => {
    if (cur.trim()) out.push({ text: cur.trim(), context: trail(curPath), source: "prose" });
    cur = "";
  };

  for (const b of blocks) {
    // A fence is its OWN chunk, never mixed with the prose around it. gbrain's
    // reason, and it is a measured one: ~40% of a brain is docs with inline
    // code, and when a fence chunks as prose, "how do we import from engine"
    // ranks the paragraph ABOUT the import above the import itself.
    if (b.atomic) {
      push();
      curPath = b.path;
      // The ceiling: an oversized fence splits at line boundaries (softSplit
      // prefers \n), each piece still code — see FENCE_CEILING for why.
      if (b.text.length > FENCE_CEILING) {
        for (const piece of softSplit(b.text, FENCE_CEILING / 2))
          out.push({ text: piece, context: "", source: "code" });
      } else {
        out.push({ text: b.text, context: "", source: "code" });
      }
      continue;
    }

    const changedSection = trail(curPath) !== trail(b.path);
    // A new section starts a new chunk when there is already enough in hand;
    // starting one for every heading would shatter a document of short sections.
    if (
      cur &&
      (cur.length + b.text.length + 2 > target || (changedSection && cur.length > target * 0.5))
    ) {
      push();
    }
    curPath = b.path;
    cur = cur ? `${cur}\n\n${b.text}` : b.text;
    if (cur.length > target * 2) {
      const parts = softSplit(cur, target);
      cur = parts.pop() ?? "";
      for (const p of parts) out.push({ text: p, context: trail(b.path), source: "prose" });
    }
  }
  push();
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
export function maskCode(body: string): string {
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
function mdTargetToRef(raw: string, fromSlug?: string): string | null {
  // Drop an optional link title: [x](path "Title")
  const target = raw.replace(/\s+["'(].*$/, "").trim();
  if (!target) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  if (target.startsWith("#")) return null;
  // decodeURIComponent THROWS on malformed percent-encoding — a link like
  // [x](report-100%.md), which a human writes without thinking. An exception
  // here would propagate out of extractRefs and fail the whole page write, so a
  // single odd link would abort a vault import.
  let path: string;
  const bare = target.split("#")[0];
  try {
    path = decodeURIComponent(bare);
  } catch {
    path = bare;
  }
  // A relative link is RESOLVED against the referring page's folder, not
  // flattened. `../Maps/Note.md` written in `v/notes/x` means `v/maps/note`,
  // and stripping the `../` used to make it mean `maps/note` — a different
  // page, or none at all once a vault is imported under a folder prefix. It
  // only looked harmless while ref matching fell back to bare filenames; now
  // that a ref containing a separator is an ADDRESS naming exactly one page,
  // a mis-resolved prefix is a silently wrong or permanently broken edge.
  if (/^\.{1,2}\//.test(path)) {
    const base = (fromSlug ?? "").split("/").slice(0, -1);
    for (const seg of path.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") base.pop();
      else base.push(seg);
    }
    path = base.join("/");
  }
  if (!path) return null;
  // NOTE_EXT, imported rather than re-spelled. This test used to be
  // `ext !== "md"`, a third reader of "which extensions are a page" that
  // disagreed with the two in vault.ts: a `.markdown` target returned null, so
  // [Other](Notes/Other.markdown) produced no ref, no edge, and — because
  // list_broken_links reports refs that RESOLVED to nothing, not refs that were
  // never extracted — no report either. A link to a real page, invisible.
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1];
  if (ext && !NOTE_EXT.test(path)) return null;
  return path.replace(NOTE_EXT, "");
}

// Every way a page can point at another page: [[wikilinks]] (with #section and
// |alias), Markdown links, and both of those inside frontmatter values — real
// vaults put structure in Properties (`up: "[[MOC]]"`, `related: ["[[A]]"]`),
// and a body-only extractor imports those notes as edgeless dots.
// `![[embed]]` and `![](img.png)` are attachments, not links.
// ponytail: a Markdown link whose TEXT contains a wikilink yields both refs;
// they dedupe when they resolve to the same page, and are genuinely two
// references when they don't. Not worth span-tracking machinery.
export function extractRefs(
  body: string,
  frontmatter?: Record<string, unknown>,
  // The page the refs are written ON. Only relative Markdown links need it, and
  // only they can be wrong without it.
  fromSlug?: string,
): string[] {
  const refs = new Set<string>();
  const scan = (text: string) => {
    const masked = maskCode(text);
    for (const m of masked.matchAll(WIKILINK)) if (!m[1]) addRef(refs, m[2]);
    for (const m of masked.matchAll(MDLINK)) {
      const ref = mdTargetToRef(m[1], fromSlug);
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
  /** Prepended to QUERY text only. Empty means the model wants no instruction. */
  queryPrefix?: string;
}

export function embeddingsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig {
  return {
    url: env.EMBEDDINGS_URL ?? "",
    apiKey: env.EMBEDDINGS_API_KEY ?? "",
    model: env.EMBEDDINGS_MODEL ?? "unconfigured",
    dim: Number(env.EMBEDDINGS_DIM ?? 1536),
    // Not part of the embedding space the meta row pins: changing it changes how
    // a QUERY is encoded, not what is stored, so it needs no re-embed and must
    // not trip the model/dim mismatch guard.
    queryPrefix: env.EMBEDDINGS_QUERY_PREFIX ?? "",
  };
}

// OpenAI-compatible /embeddings client. Fails loud on misconfig — a write that
// can't embed must not half-land (the store only writes after embedding).
export function makeEmbedFn(cfg: EmbeddingsConfig): EmbedFn {
  return async (texts: string[], role: "query" | "document" = "document"): Promise<number[][]> => {
    if (texts.length === 0) return [];
    if (!cfg.url || !cfg.apiKey) {
      throw new Error(
        "embeddings not configured: set EMBEDDINGS_URL, EMBEDDINGS_API_KEY, EMBEDDINGS_MODEL, EMBEDDINGS_DIM",
      );
    }
    const prefix = role === "query" ? (cfg.queryPrefix ?? "") : "";
    const input = prefix ? texts.map((t) => prefix + t) : texts;
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, input, dimensions: cfg.dim }),
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
