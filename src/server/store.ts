// The standalone brain: pages + chunks + edges over one Postgres, hybrid
// retrieval (vector + FTS + trigram → RRF), wikilink graph with forward-
// reference resolution. Single-tenant by design — no sources, no scopes.

import { type Db, type Query, REF_KEY_SQL } from "./db";
import { type MemoryItem, rowToMemory } from "./memory/items";
import { isMemorySlug, projectionSlug, renderProjection } from "./memory/projection";
import { GAZETTEER_PREFIXES, buildGazetteer, findMentions } from "./mentions";
import {
  type EmbedFn,
  chunkBody,
  extractRefs,
  frontmatterAliases,
  normalizeRef,
  normalizeSlugish,
} from "./pipeline";
import { isTitlePhraseMatch } from "./title-match";

export type PageKind = "note" | "memory";

export interface PutPageArgs {
  slug: string;
  title?: string;
  body: string;
  kind?: PageKind;
  frontmatter?: Record<string, unknown>;
}

export interface PageHit {
  slug: string;
  title: string;
  type?: string;
  updated_at: string;
  score?: number;
  chunk_text?: string;
  evidence?: string;
}

const SLUG_RE = /^[^\s[\]|#]{1,512}$/;
const RRF_K = 60;
// How many typed pages the mention gazetteer will load. A ceiling, not a
// policy: the sweep only ever uses names from slug-prefixed typed pages, and
// past this many of them it under-links (the same safe direction
// MIN_NAME_LENGTH picks) instead of pulling an unbounded vault into memory.
const GAZETTEER_LIMIT = 5000;
const ARM_LIMIT = 40;
// Basename candidates the ref resolver pulls before the path filter below runs.
// Shortest slug first, so the cap only ever drops pages that lost the tie-break
// anyway; a path-shaped ref whose target sits past it stays PARKED (and visible
// in list_broken_links) instead of landing on the wrong page.
const BASENAME_CANDIDATES = 25;
// ANN candidates pulled before per-page max-pool: multi-chunk pages and
// soft-deleted rows both eat slots, so over-fetch well past ARM_LIMIT.
const ANN_OVERFETCH = ARM_LIMIT * 5;
// Ranking weights. Changing either MUST move the numbers in
// tests/retrieval-eval.test.ts, which is the whole reason that file exists.
const TITLE_BOOST = 1.25;
const BACKLINK_WEIGHT = 0.05;
// A guard, not a policy: one pasted logfile would otherwise become thousands of
// chunks, one enormous embeddings bill, and a request that cannot finish inside
// a Worker's CPU budget. Far above any real note.
const MAX_BODY_CHARS = 1_000_000;

function sha256Hex(s: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then((buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
}

function titleFromBody(body: string, slug: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const seg = slug.split("/").at(-1) ?? slug;
  return seg.replace(/[-_]+/g, " ").trim() || slug;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

// Mirrors the slug-prefix inference the graph view does client-side
// (src/lib/graph.ts) so the dashboard breakdown, type chips, and a page's
// PROPERTIES panel agree with the colors on the graph. An explicit
// frontmatter.type always wins.
const SLUG_TYPES: [string, string][] = [
  ["people/", "person"],
  ["companies/", "company"],
  ["entities/", "product"],
  ["concepts/", "concept"],
];

function pageType(row: { slug?: unknown; kind?: unknown; frontmatter?: unknown }): string {
  const fm = row.frontmatter as Record<string, unknown> | null;
  if (fm && typeof fm.type === "string" && fm.type) return fm.type;
  if (row.kind === "memory") return "memory";
  const slug = typeof row.slug === "string" ? row.slug : "";
  for (const [prefix, type] of SLUG_TYPES) if (slug.startsWith(prefix)) return type;
  return "note";
}

// Escape LIKE metacharacters so a query containing % or _ is matched
// literally instead of turning into a wildcard that matches everything.
export function likeLiteral(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

// ONE normalization for every slug that NAMES a page, applied before anything
// decides anything about it. A guard that reads the caller's raw string while the
// row is written from a trimmed one is not a guard: " memory/vault/x" does not
// start with "memory/" and still writes memory/vault/x. Whitespace of every kind
// (space, tab, newline, NBSP) is settled here; whatever is left is caught by
// SLUG_RE, which forbids whitespace outright. Exported so an outer door can
// decide on the SAME string the store persists instead of on the raw input.
export function normalizePageSlug(slug: unknown): string {
  return typeof slug === "string" ? slug.trim() : "";
}

// Fold a slug or a path-shaped ref to one comparable form, per SEGMENT: the
// quote/separator folding that lets [[Reading MOC]] find reading-moc has to apply
// to a path's own last segment too, or 'qq/"Quoted"' and qq/quoted stop agreeing.
// Leading ./ and ../ are noise (Logseq/Foam exports emit them).
function foldPath(s: string): string {
  return s
    .replace(/^(?:\.{1,2}\/)+/, "")
    .split("/")
    .map(normalizeSlugish)
    .join("/");
}

// A slug is also a PATH: /api/export writes `${slug}.md` into a tar, so a
// leading '/' or a '.'/'..' segment either escapes the extraction directory or
// makes GNU tar refuse the whole archive (exit 2) and take the user's own
// restore with it. Rejected at the write path, which is the only place that can
// stop it. Empty segments cover '/abs', 'trailing/' and 'a//b' at once.
function invalidSlug(slug: string): boolean {
  return (
    !SLUG_RE.test(slug) || slug.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  );
}

// The JS half of REF_KEY_SQL (db.ts): the coarse key a parked ref is looked up
// by. Over-matching is the point — resolveRef decides.
function refKey(s: string): string {
  return normalizeRef(s.replace(/^.*\//, "")).replace(/[-_ ]+/g, "");
}

export interface Store {
  putPage(args: PutPageArgs): Promise<{ slug: string; unchanged: boolean; pending: string[] }>;
  remember(args: {
    memory: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ slug: string }>;
  deletePage(args: { slug: string }): Promise<{ slug: string; deleted: true }>;
  restorePage(args: { slug: string }): Promise<{ slug: string; restored: true }>;
  renamePage(args: { slug: string; to: string }): Promise<{ slug: string; from: string }>;
  findOrphans(args: { limit?: number }): Promise<{ slug: string; title: string }[]>;
  brokenLinks(args: { limit?: number }): Promise<{ from_slug: string; ref: string }[]>;
  getPage(args: { slug: string; fuzzy?: boolean }): Promise<Record<string, unknown>>;
  listPages(args: { limit?: number; kind?: string }): Promise<PageHit[]>;
  search(args: { query: string; limit?: number }): Promise<PageHit[]>;
  getBacklinks(args: { slug: string }): Promise<{ slug: string; title: string }[]>;
  traverseGraph(args: {
    slug: string;
    depth?: number;
    direction?: string;
  }): Promise<{ from_slug: string; to_slug: string }[]>;
  recentPages(args: { days?: number; limit?: number }): Promise<PageHit[]>;
  pageCount(): Promise<number>;
  // Deterministic mention linking into the 'auto' edge lane. Returns what it
  // did so a caller can page through the brain, and takes a lease so two
  // schedulers cannot sweep at once.
  sweepMentions(args: { limit?: number; dryRun?: boolean }): Promise<{
    scanned: number;
    edgesAdded: number;
    remaining: number;
    pairs: { from_slug: string; to_slug: string }[];
  }>;
  clearAutoEdges(): Promise<{ removed: number }>;
  // Cursor-paged for export: streaming beats materializing the whole brain.
  exportBatch(args: { afterSlug?: string; limit?: number }): Promise<
    { slug: string; title: string; body: string; frontmatter: Record<string, unknown> }[]
  >;
}

export function createStore(db: Db, embed: EmbedFn): Store {
  // Resolve a ref to a page id, in order of how specific the match is: exact
  // slug, exact title, last slug segment ([[Some Note]] -> notes/some-note),
  // then a declared alias. Everything is compared through normalizeRef so a
  // stored key and a lookup can never disagree.
  // ponytail: 4 indexed point-lookups, not one big OR — cheap, and each arm's
  // precedence is readable. Ties break on the shortest slug, then alphabetically,
  // so a denser graph never depends on row order.
  async function resolveRef(q: Query, ref: string): Promise<number | null> {
    const norm = normalizeRef(ref);
    if (!norm) return null;
    const slugish = normalizeSlugish(ref.replace(/^.*\//, ""));
    // A ref that names a PATH ("Maps/Late Note") asserts a LOCATION, not just a
    // filename, so the basename arm must not satisfy it with a page in some other
    // directory that merely shares a last segment. That mis-attachment is worse
    // than the broken link it replaces: the edge points at the wrong page AND the
    // parked row is consumed, so the real target arriving later gets nothing and
    // no later write repairs it. The ref's path must be a suffix of the page's
    // (ceiling: a ref carrying a directory the import stripped stays parked and
    // shows up in list_broken_links, rather than being guessed at).
    const wantPath = foldPath(ref);
    const keepPath = (row: Record<string, unknown>) => {
      const folded = foldPath(String(row.slug));
      return folded === wantPath || folded.endsWith(`/${wantPath}`);
    };
    const arms: [string, unknown[], ((row: Record<string, unknown>) => boolean)?][] = [
      ["SELECT id FROM pages WHERE slug = $1 AND deleted_at IS NULL", [normalizePageSlug(ref)]],
      [
        `SELECT id FROM pages WHERE lower(btrim(title)) = $1 AND deleted_at IS NULL
         ORDER BY length(slug), slug LIMIT 1`,
        [norm],
      ],
      [
        // The ref's own last segment, so a path-ish ref ("Maps/Reading MOC",
        // or ../Maps/Reading MOC.md after extraction) matches a page's
        // filename the same way a bare [[Reading MOC]] does.
        // BOTH Unicode forms: pages.basename is built by SQL from the raw slug,
        // and macOS hands the importer NFD filenames while the ref inside the
        // note is typed NFC — comparing one form only makes this arm miss every
        // accented or CJK filename in a Mac vault. (What it still cannot reach
        // is documented on pages.basename in db.ts.)
        `SELECT id, slug FROM pages WHERE basename = ANY($1::text[]) AND deleted_at IS NULL
         ORDER BY length(slug), slug LIMIT ${BASENAME_CANDIDATES}`,
        [[...new Set([slugish, slugish.normalize("NFD")])]],
        wantPath.includes("/") ? keepPath : undefined,
      ],
      [
        `SELECT id FROM pages
         WHERE frontmatter->'aliases' @> to_jsonb($1::text) AND deleted_at IS NULL
         ORDER BY length(slug), slug LIMIT 1`,
        [norm],
      ],
    ];
    for (const [sql, params, keep] of arms) {
      const res = await q(sql, params);
      const row = keep ? res.rows.find(keep) : res.rows[0];
      if (row) return Number(row.id);
    }
    return null;
  }

  // Forward references: pages that linked THIS page before it existed now get
  // their edge, and the pending row is consumed. Vault import walks files in
  // directory order, so this is the COMMON case, not the exotic one — a forward
  // ref that never lands is the edgeless graph /import and GraphHealth exist to
  // explain. Both writes that can make a name resolvable (a put and a rename)
  // call this, so a name is never resolvable-but-unswept.
  // ONE resolution rule: the query below is only a CANDIDATE filter and
  // resolveRef decides where each ref lands. Re-implementing the arms here is
  // what silently dropped every slug-style ([[late-note-a]]) and path-style
  // ([[Maps/Late Note]]) ref: they are parked under normalizeRef but were matched
  // against a normalizeSlugish key nothing ever wrote.
  // It is NOT the superset of resolveRef the previous comment here claimed, and
  // claiming it hid two real misses. Both come from the coarse key being computed
  // by JS on this side (refKey, on the slug) and by SQL on the other (REF_KEY_SQL,
  // over a ref_norm that JS already folded):
  //   - ORDER. normalizeRef strips end quotes from the WHOLE ref before SQL strips
  //     the path, while refKey strips the path first. [[qq/'Quoted Uniq']] keys as
  //     "'quoteduniq" here and "quoteduniq" there, so qq/quoted-uniq never sweeps
  //     it — even though resolveRef matches it fine once the page exists.
  //   - UNICODE. SQL lower() and JS toLowerCase() disagree on a dotted 'İ', a
  //     ligature, a fullwidth letter (the same gap documented on pages.basename in
  //     db.ts, which also costs resolveRef its title and basename arms there).
  // Closing them means storing the key as a column written by refKey in JS, which
  // is a SCHEMA_VERSION bump and an index rebuild — worth doing, not worth
  // half-doing. Until then the miss is BOUNDED and visible: the row stays parked
  // and list_broken_links names it. What it must never do is land on the wrong
  // page, which is why resolveRef re-checks every candidate.
  async function landPendingRefs(
    q: Query,
    pageId: number,
    names: string[],
    key: string,
  ): Promise<void> {
    const pend = await q(
      `SELECT from_page_id, target_ref FROM pending_links
       WHERE ref_norm = ANY($1::text[]) OR ${REF_KEY_SQL} = $2::text`,
      // A separators-only basename keys as '', which selects only the parked refs
      // that are separators-only too — a handful, and indexed. Disabling that arm
      // (as this used to) was one more ref that resolved backward and could never
      // land forward, for no bounded gain.
      [[...new Set(names.filter(Boolean))], key],
    );
    for (const row of pend.rows) {
      const fromId = Number(row.from_page_id);
      if (fromId === pageId) continue;
      const ref = String(row.target_ref);
      const toId = await resolveRef(q, ref);
      if (toId === null || toId === fromId) continue;
      await q(
        "INSERT INTO edges (from_page_id, to_page_id, lane, kind) VALUES ($1, $2, 'declared', 'wikilink') ON CONFLICT DO NOTHING",
        [fromId, toId],
      );
      await q("DELETE FROM pending_links WHERE from_page_id = $1 AND target_ref = $2", [
        fromId,
        ref,
      ]);
    }
  }

  // Who owns a page in the reserved memory/ namespace, decided from DATA rather
  // than from who is calling: a page under memory/ is the projection of a
  // COMMITTED memory or it is nothing (AGENTS.md, layer 4). Returns that memory,
  // so the caller can hold the projection to it.
  async function projectionOwner(slug: string): Promise<MemoryItem | null> {
    const id = slug.split("/").at(-1) ?? "";
    try {
      const res = await db.query(
        "SELECT * FROM memory_items WHERE id = $1 AND status = 'committed'",
        [id],
      );
      if (!res.rows.length) return null;
      const owner = rowToMemory(res.rows[0]);
      // projectionSlug is the authority on where a memory's page lives, so the
      // shape is never re-derived here: same function, one definition.
      return projectionSlug(owner) === slug ? owner : null;
    } catch {
      // No memory tables at all (a brain older than v4): nothing owns anything.
      return null;
    }
  }

  // `revive` is the store's OWN restore path re-writing a page from the row it
  // just read (see restorePage) — it cannot introduce foreign content, so it is
  // exempt from the body rule below. It is a private parameter: the Store the
  // factory returns wraps putPage in a one-argument function, so no caller
  // outside this file can set it.
  async function putPage(
    args: PutPageArgs,
    revive = false,
  ): Promise<{ slug: string; unchanged: boolean; pending: string[] }> {
    const slug = normalizePageSlug(args.slug);
    if (!slug || invalidSlug(slug)) {
      throw new Error(
        `invalid slug: must be a relative path, non-empty, no whitespace, []|#, '.'/'..' segments (got ${JSON.stringify(args.slug)})`,
      );
    }
    if (typeof args.body !== "string") throw new Error("body must be a string");
    if (args.body.length > MAX_BODY_CHARS) {
      throw new Error(
        `body too large: ${args.body.length} chars exceeds the ${MAX_BODY_CHARS} limit`,
      );
    }
    // Every path that creates or revives a page goes through here, so this ONE
    // check covers put_page, /api/import, restore_page and remember — and it reads
    // the SAME normalized slug the row is written from, which is the whole bug: the
    // outer guard tested the caller's raw string, so put_page{slug:"
    // memory/vault/<id>"} walked past it and the upsert's deleted_at = NULL
    // resurrected the page of a REVOKED memory. No arm of runProjections' due query
    // repairs that, so it never converged.
    const owner = isMemorySlug(slug) ? await projectionOwner(slug) : null;
    if (isMemorySlug(slug) && !owner) {
      throw new Error(`slug '${slug}' is reserved for generated memory projections`);
    }
    // ...and owning the slug is not enough: the page is a pure function of the
    // memory, so the only body that may be written to it is the one that memory
    // renders. Without this, a forged put at the canonical slug of a still-
    // committed memory replaces the searchable text permanently — memory_items
    // keeps the true value, projection_status stays 'ok', and nothing re-renders it.
    // A legitimate re-projection always passes exactly this body, so this can only
    // fire on a forgery or on a caller projecting a STALE snapshot (which fails the
    // projection and is retried from the current row).
    // ponytail: frontmatter and kind are still the caller's on an owned slug —
    // metadata, not the text search and recall read. Refusing the namespace
    // outright is the untrusted door's job (mcp, /api/import), on this same
    // normalized string; normalizePageSlug is exported for exactly that.
    if (owner && !revive && args.body !== renderProjection(owner).body) {
      throw new Error(
        `slug '${slug}' is reserved for generated memory projections: its body is rendered from memory ${owner.id}`,
      );
    }
    const prior = await db.query(
      "SELECT content_hash, kind, frontmatter FROM pages WHERE slug = $1 AND deleted_at IS NULL",
      [slug],
    );
    const existing = prior.rows[0];

    // Omitting a field updates nothing: put_page is the only way to edit a
    // page, so an agent editing a memory's body must not silently demote it to
    // a note or drop its category / related_ids (which are graph edges). Pass
    // frontmatter: {} to clear it deliberately.
    const kind =
      args.kind === "memory" || args.kind === "note"
        ? args.kind
        : ((existing?.kind as PageKind | undefined) ?? "note");
    const frontmatter =
      args.frontmatter ?? ((existing?.frontmatter as Record<string, unknown> | undefined) || {});
    // A projection page's title is derived too — taken from the canonical body's
    // own H1 rather than from the caller, or a forged title on an honest body
    // still poisons search (title is half the fts vector).
    const title = owner
      ? titleFromBody(args.body, slug)
      : (args.title ?? "").trim() || titleFromBody(args.body, slug);
    // Hash every field a write can change - kind included, or flipping a
    // page between note and memory hashes the same and gets skipped as
    // "unchanged". JSON-encoding the tuple keeps field boundaries clear.
    const hash = await sha256Hex(JSON.stringify([kind, title, args.body, frontmatter]));
    // (hash covers the caller's frontmatter; alias normalization is derived)

    if (existing && existing.content_hash === hash) {
      // Idempotent re-ingest: skip embedding entirely. Still report what does
      // not resolve, so a caller re-putting a page learns about broken links.
      const stillPending = await db.query(
        "SELECT target_ref FROM pending_links WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1)",
        [slug],
      );
      return {
        slug,
        unchanged: true,
        pending: stillPending.rows.map((r) => String(r.target_ref)),
      };
    }

    // Embed BEFORE writing: a failed embed leaves nothing half-written, so no
    // compensation machinery. ponytail: couples writes to embeddings-provider
    // uptime; add an indexed_at watermark + re-embed sweep if that ever bites.
    const chunks = chunkBody(args.body);
    const vectors = await embed(chunks);

    const refs = extractRefs(args.body, frontmatter);
    // Normalize declared aliases in place so the alias arm's @> containment
    // check compares like with like.
    const aliases = frontmatterAliases(frontmatter);
    const storedFrontmatter = aliases.length ? { ...frontmatter, aliases } : frontmatter;
    const related = Array.isArray(frontmatter.related_ids)
      ? (frontmatter.related_ids as unknown[]).filter((r): r is string => typeof r === "string")
      : [];

    const pending: string[] = [];
    await db.tx(async (q) => {
      const up = await q(
        `INSERT INTO pages (slug, kind, title, body, frontmatter, content_hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (slug) DO UPDATE SET
           kind = EXCLUDED.kind, title = EXCLUDED.title, body = EXCLUDED.body,
           frontmatter = EXCLUDED.frontmatter, content_hash = EXCLUDED.content_hash,
           deleted_at = NULL, updated_at = now()
         RETURNING id, title`,
        [slug, kind, title, args.body, JSON.stringify(storedFrontmatter), hash],
      );
      const pageId = Number(up.rows[0].id);

      await q("DELETE FROM chunks WHERE page_id = $1", [pageId]);
      for (let i = 0; i < chunks.length; i++) {
        await q(
          "INSERT INTO chunks (page_id, seq, text, embedding) VALUES ($1, $2, $3, $4::vector)",
          [pageId, i, chunks[i], JSON.stringify(vectors[i])],
        );
      }

      // Rebuild declared edges from this page.
      await q("DELETE FROM edges WHERE from_page_id = $1 AND lane = 'declared'", [pageId]);
      await q("DELETE FROM pending_links WHERE from_page_id = $1", [pageId]);
      const targets = new Map<number, string>(); // id -> kind (wikilink wins over related)
      const park = async (ref: string) => {
        pending.push(ref);
        await q(
          `INSERT INTO pending_links (from_page_id, target_ref, ref_norm) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [pageId, ref, normalizeRef(ref)],
        );
      };
      for (const ref of related) {
        const id = await resolveRef(q, ref);
        if (id !== null && id !== pageId) targets.set(id, "related");
        else if (id === null) await park(ref);
      }
      for (const ref of refs) {
        const id = await resolveRef(q, ref);
        if (id !== null && id !== pageId) targets.set(id, "wikilink");
        else if (id === null) await park(ref);
      }
      for (const [toId, edgeKind] of targets) {
        await q(
          "INSERT INTO edges (from_page_id, to_page_id, lane, kind) VALUES ($1, $2, 'declared', $3) ON CONFLICT DO NOTHING",
          [pageId, toId, edgeKind],
        );
      }

      await landPendingRefs(
        q,
        pageId,
        [normalizeRef(slug), normalizeRef(String(up.rows[0].title)), ...aliases],
        refKey(slug),
      );
    });
    return { slug, unchanged: false, pending };
  }

  return {
    // One argument on purpose: `revive` stays private to this file.
    putPage: (args) => putPage(args),

    async remember({ memory, metadata }) {
      if (typeof memory !== "string" || !memory.trim())
        throw new Error("memory must be a non-empty string");
      // An MCP retry replays the same call, and every remember mints a fresh
      // uuid slug -- so without this the same memory lands twice under two
      // slugs that content_hash can never reconcile. Exact match only: no
      // threshold, nothing to tune.
      const dupe = await db.query(
        `SELECT slug FROM pages
         WHERE kind = 'memory' AND deleted_at IS NULL AND body = $1 AND frontmatter = $2::jsonb
         LIMIT 1`,
        [memory, JSON.stringify(metadata ?? {})],
      );
      if (dupe.rows.length) return { slug: String(dupe.rows[0].slug) };
      const slug = `mem-${crypto.randomUUID()}`;
      const firstLine = memory.trim().split("\n")[0].slice(0, 80);
      const title = typeof metadata?.title === "string" ? metadata.title : firstLine;
      await putPage({ slug, title, body: memory, kind: "memory", frontmatter: metadata ?? {} });
      return { slug };
    },

    async deletePage(args) {
      const slug = normalizePageSlug(args.slug);
      return db.tx(async (q) => {
        const res = await q(
          "UPDATE pages SET deleted_at = now(), updated_at = now() WHERE slug = $1 AND deleted_at IS NULL RETURNING id",
          [slug],
        );
        if (!res.rows.length) throw new Error(`not_found: ${slug}`);
        // Drop the chunks: the vector arm's inner query must stay a bare
        // ORDER BY/LIMIT to keep the HNSW index, so its candidates are filtered
        // by deleted_at only AFTER the LIMIT. Leaving dead chunks in place lets
        // every delete permanently steal ANN slots and quietly degrade search.
        // The pages row (body, edges, frontmatter) stays, so restore can rebuild.
        await q("DELETE FROM chunks WHERE page_id = $1", [Number(res.rows[0].id)]);
        return { slug, deleted: true as const };
      });
    },

    async restorePage(args) {
      const slug = normalizePageSlug(args.slug);
      const res = await db.query(
        `SELECT title, body, kind, frontmatter FROM pages
         WHERE slug = $1 AND deleted_at IS NOT NULL`,
        [slug],
      );
      const row = res.rows[0];
      if (!row) throw new Error(`not_found: no deleted page with slug ${slug}`);
      // The whole restore is putPage's single transaction, on purpose: its
      // prior-state lookup filters on deleted_at IS NULL, so a deleted row is
      // invisible to the content_hash short-circuit (nothing to clear), and the
      // upsert's DO UPDATE clears deleted_at in the SAME transaction that
      // rebuilds the chunks deletePage dropped. Embedding happens before that
      // transaction, so a provider failure leaves the page deleted and the
      // restore retryable. Un-deleting first left a live, zero-chunk page with
      // no deleted row to restore from — invisible to the vector arm, and
      // unrecoverable. kind/frontmatter must be passed explicitly for the same
      // reason: there is no visible prior row to inherit them from.
      await putPage(
        {
          slug,
          title: String(row.title),
          body: String(row.body),
          kind: row.kind as PageKind,
          frontmatter: (row.frontmatter as Record<string, unknown>) ?? {},
        },
        // The body comes from this page's own row, so a projection whose memory
        // has moved on since is still revivable — the sweep re-renders it right
        // after. Refusing it here would strand an evicted page forever.
        true,
      );
      return { slug, restored: true as const };
    },

    // Rename in place. Edges are keyed by page id so they survive untouched;
    // the old slug is appended to this page's own aliases, which is what makes
    // every stale [[old-slug]] elsewhere keep resolving. Deliberately does NOT
    // rewrite other pages' bodies: that would mutate notes the user did not
    // touch, change their content_hash, and re-embed every referrer.
    async renamePage(args) {
      const from = normalizePageSlug(args.slug);
      const target = normalizePageSlug(args.to);
      if (!target || invalidSlug(target))
        throw new Error(`invalid slug: ${JSON.stringify(args.to)}`);
      // Decided on the NORMALIZED destination, so " memory/vault/squat" cannot
      // walk in past a check that read the raw string. Nothing legitimately
      // renames INTO the namespace — projections are created by putPage — so this
      // end is closed outright. Renaming OUT of it stays possible at the store
      // level on purpose: a database written before the guard existed already has
      // a projection sitting outside memory/, forget addresses it by its stored
      // projection_page_id, and brain-mcp pins that that page is still retracted.
      if (isMemorySlug(target)) {
        throw new Error(`slug '${target}' is reserved for generated memory projections`);
      }
      if (target === from) return { slug: target, from };
      return db.tx(async (q) => {
        const cur = await q(
          "SELECT id, frontmatter FROM pages WHERE slug = $1 AND deleted_at IS NULL",
          [from],
        );
        if (!cur.rows.length) throw new Error(`not_found: ${from}`);
        const clash = await q("SELECT 1 FROM pages WHERE slug = $1", [target]);
        if (clash.rows.length) throw new Error(`slug already taken: ${target}`);
        const fm = (cur.rows[0].frontmatter as Record<string, unknown>) ?? {};
        const aliases = new Set(frontmatterAliases(fm));
        aliases.add(normalizeRef(from));
        aliases.delete(normalizeRef(target));
        const pageId = Number(cur.rows[0].id);
        await q(
          "UPDATE pages SET slug = $1, frontmatter = $2::jsonb, updated_at = now() WHERE id = $3",
          [target, JSON.stringify({ ...fm, aliases: [...aliases] }), pageId],
        );
        // A rename makes a NAME resolvable, exactly like a put does: refs parked on
        // [[moved/here]] before anything lived there stayed parked forever, with
        // list_broken_links still accusing them, because only putPage swept.
        await landPendingRefs(q, pageId, [normalizeRef(target)], refKey(target));
        return { slug: target, from };
      });
    },

    // Pages nothing points to. The defect a force-directed graph makes visually
    // obvious and that no other read answers.
    async findOrphans({ limit }) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const res = await db.query(
        `SELECT p.slug, p.title FROM pages p
         WHERE p.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM edges e JOIN pages src ON src.id = e.from_page_id
             WHERE e.to_page_id = p.id AND src.deleted_at IS NULL
           )
         ORDER BY p.updated_at DESC LIMIT $1`,
        [n],
      );
      return res.rows.map((r) => ({ slug: String(r.slug), title: String(r.title) }));
    },

    // Refs that point at a page which does not exist — the precise complement
    // of findOrphans, and the answer to "why does my imported graph look empty".
    async brokenLinks({ limit }) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const res = await db.query(
        `SELECT p.slug AS from_slug, pl.target_ref AS ref
         FROM pending_links pl JOIN pages p ON p.id = pl.from_page_id
         WHERE p.deleted_at IS NULL
         ORDER BY p.updated_at DESC, pl.target_ref LIMIT $1`,
        [n],
      );
      return res.rows.map((r) => ({ from_slug: String(r.from_slug), ref: String(r.ref) }));
    },

    async getPage({ slug: raw, fuzzy }) {
      const slug = normalizePageSlug(raw);
      const cols = "slug, kind, title, body, frontmatter, created_at, updated_at";
      let res = await db.query(`SELECT ${cols} FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [
        slug,
      ]);
      if (!res.rows.length && fuzzy) {
        res = await db.query(
          `SELECT ${cols} FROM pages WHERE deleted_at IS NULL AND lower(title) = lower($1)
           ORDER BY updated_at DESC LIMIT 1`,
          [slug],
        );
      }
      if (!res.rows.length && fuzzy) {
        // Escaped: an unescaped '%' or '_' in the argument is a wildcard, so
        // asking for a page named "50%" (or "%") returned an arbitrary page
        // instead of the one whose title contains that text.
        res = await db.query(
          `SELECT ${cols} FROM pages WHERE deleted_at IS NULL
             AND title ILIKE '%' || $1 || '%' ESCAPE '\\'
           ORDER BY length(title) ASC, updated_at DESC LIMIT 1`,
          [likeLiteral(slug)],
        );
      }
      const row = res.rows[0];
      // lore matches /not_found/ against this text to show its missing-page UX.
      if (!row) throw new Error(`not_found: ${slug}`);
      return {
        slug: row.slug,
        title: row.title,
        type: pageType(row),
        body: row.body,
        frontmatter: row.frontmatter,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      };
    },

    async listPages({ limit, kind }) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
      // kind narrows to notes or memories; anything else lists everything, so
      // lore's own unfiltered call is unaffected.
      const only = kind === "memory" || kind === "note" ? kind : null;
      const res = await db.query(
        `SELECT slug, kind, title, frontmatter, updated_at FROM pages
         WHERE deleted_at IS NULL AND ($2::text IS NULL OR kind = $2)
         ORDER BY updated_at DESC LIMIT $1`,
        [n, only],
      );
      return res.rows.map((r) => ({
        slug: String(r.slug),
        title: String(r.title),
        type: pageType(r),
        updated_at: iso(r.updated_at),
      }));
    },

    async search({ query, limit }) {
      const n = Math.min(Math.max(Number(limit) || 25, 1), 200);
      const trimmed = (query ?? "").trim();
      if (!trimmed) return [];

      type Arm = { label: "vector" | "keyword"; rows: { page_id: number; chunk?: string }[] };
      const arms: Arm[] = [];

      // Lexical arm 1: FTS over title+body (page grain).
      const fts = await db.query(
        `SELECT p.id AS page_id, ts_rank_cd(p.fts, q) AS score
         FROM pages p, websearch_to_tsquery('simple', $1) q
         WHERE p.deleted_at IS NULL AND p.fts @@ q
         ORDER BY score DESC LIMIT ${ARM_LIMIT}`,
        [trimmed],
      );
      arms.push({ label: "keyword", rows: fts.rows.map((r) => ({ page_id: Number(r.page_id) })) });

      // Lexical arm 2: trigram word-similarity over chunks + titles, plus an
      // exact-substring ILIKE floor — together the CJK arm ('simple' tsvector
      // can't segment CJK, and trigram alnum classing is locale-dependent).
      // ponytail: seq scans, fine to ~50k chunks; add GIN + % if it slows.
      const trgm = await db.query(
        `SELECT s.page_id, MAX(s.sim) AS score,
                (ARRAY_AGG(s.text ORDER BY s.sim DESC))[1] AS best_chunk
         FROM (
           SELECT c.page_id, word_similarity($1, c.text) AS sim, c.text
           FROM chunks c JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL
           UNION ALL
           SELECT p.id, word_similarity($1, p.title) AS sim, p.title
           FROM pages p WHERE p.deleted_at IS NULL
           UNION ALL
           SELECT c.page_id, 0.29 AS sim, c.text
           FROM chunks c JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL
           WHERE c.text ILIKE '%' || $2 || '%' ESCAPE '\\'
           UNION ALL
           SELECT p.id, 0.3 AS sim, p.title
           FROM pages p WHERE p.deleted_at IS NULL AND p.title ILIKE '%' || $2 || '%' ESCAPE '\\'
         ) s
         WHERE s.sim > 0.25
         GROUP BY s.page_id ORDER BY 2 DESC LIMIT ${ARM_LIMIT}`,
        [trimmed, likeLiteral(trimmed)],
      );
      arms.push({
        label: "keyword",
        rows: trgm.rows.map((r) => ({ page_id: Number(r.page_id), chunk: String(r.best_chunk) })),
      });

      // Vector arm — degrades to lexical-only if the embed call fails, so reads
      // never depend on provider uptime. The inner SELECT is a bare
      // ORDER BY ... LIMIT over chunks on purpose: add a join, a WHERE, or the
      // GROUP BY and the planner drops the HNSW index and scans every chunk.
      // So: ANN over-fetch first, then per-page max-pool on the small result.
      // ponytail: no similarity floor - nearest-neighbour always returns
      // something, so a gibberish query still yields its N closest pages.
      // A floor is model-dependent; add one (or autocut) once tuned against
      // the embedding model actually in use.
      try {
        const [qv] = await embed([trimmed]);
        const vec = await db.query(
          `SELECT s.page_id, 1 - MIN(s.dist) AS score,
                  (ARRAY_AGG(s.text ORDER BY s.dist))[1] AS best_chunk
           FROM (
             SELECT c.page_id, c.text, c.embedding <=> $1::vector AS dist
             FROM chunks c
             ORDER BY c.embedding <=> $1::vector
             LIMIT ${ANN_OVERFETCH}
           ) s
           JOIN pages p ON p.id = s.page_id AND p.deleted_at IS NULL
           GROUP BY s.page_id
           ORDER BY 2 DESC LIMIT ${ARM_LIMIT}`,
          [JSON.stringify(qv)],
        );
        arms.push({
          label: "vector",
          rows: vec.rows.map((r) => ({ page_id: Number(r.page_id), chunk: String(r.best_chunk) })),
        });
      } catch {
        // lexical arms carry the query
      }

      // Reciprocal-rank fusion.
      const fused = new Map<number, { rrf: number; labels: Set<string>; chunk?: string }>();
      for (const arm of arms) {
        arm.rows.forEach((row, i) => {
          const cur = fused.get(row.page_id) ?? { rrf: 0, labels: new Set<string>() };
          cur.rrf += 1 / (RRF_K + i + 1);
          cur.labels.add(arm.label);
          if (!cur.chunk && row.chunk) cur.chunk = row.chunk;
          fused.set(row.page_id, cur);
        });
      }
      if (fused.size === 0) return [];

      // Two boosts, applied BEFORE the slice — after it they would only reorder
      // what the user already got, which is not the point. One extra indexed
      // query over the fused ids (<= arms x ARM_LIMIT):
      //   - title phrase: the query names this page (structural match, see
      //     title-match.ts). An Obsidian user thinks in note names.
      //   - inbound links, log-compressed: in a hand-made link graph, how many
      //     notes point at a page is a direct read of what its author treats as
      //     central. Only the 'declared' lane counts — an inferred edge must not
      //     be able to promote a page.
      // Both fail visibly (the wrong page at rank 1), which is the bar for
      // keeping a weight that no eval can calibrate. Their effect on the frozen
      // query set is recorded in tests/retrieval-eval.test.ts.
      const fusedIds = [...fused.keys()];
      const boostRows = await db.query(
        `SELECT p.id, p.title,
                (SELECT count(*) FROM edges e
                  JOIN pages src ON src.id = e.from_page_id AND src.deleted_at IS NULL
                  WHERE e.to_page_id = p.id AND e.lane = 'declared') AS inbound
         FROM pages p WHERE p.id = ANY($1::bigint[]) AND p.deleted_at IS NULL`,
        [fusedIds],
      );
      for (const row of boostRows.rows) {
        const agg = fused.get(Number(row.id));
        if (!agg) continue;
        if (isTitlePhraseMatch(trimmed, String(row.title))) {
          agg.rrf *= TITLE_BOOST;
          agg.labels.add("title");
        }
        const inbound = Number(row.inbound) || 0;
        if (inbound > 0) agg.rrf *= 1 + BACKLINK_WEIGHT * Math.log(1 + inbound);
      }

      const ranked = [...fused.entries()].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, n);
      const ids = ranked.map(([id]) => id);
      const pages = await db.query(
        `SELECT id, slug, kind, title, frontmatter, updated_at, left(body, 300) AS lede
         FROM pages WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`,
        [ids],
      );
      const byId = new Map(pages.rows.map((r) => [Number(r.id), r]));
      const max = ranked[0][1].rrf;
      return ranked.flatMap(([id, agg]) => {
        const row = byId.get(id);
        if (!row) return [];
        return [
          {
            slug: String(row.slug),
            title: String(row.title),
            type: pageType(row),
            updated_at: iso(row.updated_at),
            score: agg.rrf / max,
            chunk_text: agg.chunk ?? String(row.lede),
            evidence: [...agg.labels].join("+"),
          },
        ];
      });
    },

    async getBacklinks(args) {
      const slug = normalizePageSlug(args.slug);
      const res = await db.query(
        `SELECT src.slug, src.title
         FROM pages target
         JOIN edges e ON e.to_page_id = target.id
         JOIN pages src ON src.id = e.from_page_id AND src.deleted_at IS NULL
         WHERE target.slug = $1 AND target.deleted_at IS NULL
         ORDER BY src.updated_at DESC LIMIT 200`,
        [slug],
      );
      return res.rows.map((r) => ({ slug: String(r.slug), title: String(r.title) }));
    },

    async traverseGraph({ slug: raw, depth, direction }) {
      const slug = normalizePageSlug(raw);
      const d = Math.min(Math.max(Number(depth) || 5, 1), 10);
      const dir = direction === "in" || direction === "out" ? direction : "both";
      const step =
        dir === "out"
          ? "SELECT e.to_page_id AS next_id, n.depth + 1 AS depth FROM nodes n JOIN live_edges e ON e.from_page_id = n.id"
          : dir === "in"
            ? "SELECT e.from_page_id AS next_id, n.depth + 1 AS depth FROM nodes n JOIN live_edges e ON e.to_page_id = n.id"
            : `SELECT CASE WHEN e.from_page_id = n.id THEN e.to_page_id ELSE e.from_page_id END AS next_id,
                      n.depth + 1 AS depth
               FROM nodes n JOIN live_edges e ON e.from_page_id = n.id OR e.to_page_id = n.id`;
      // live_edges keeps the frontier on undeleted pages: walking THROUGH a
      // soft-deleted page would pull in edges from a component the seed cannot
      // actually reach, which is not what "reachable from this slug" means.
      const res = await db.query(
        `WITH RECURSIVE live_edges AS (
           SELECT e.from_page_id, e.to_page_id, pf.slug AS from_slug, pt.slug AS to_slug
           FROM edges e
           JOIN pages pf ON pf.id = e.from_page_id AND pf.deleted_at IS NULL
           JOIN pages pt ON pt.id = e.to_page_id AND pt.deleted_at IS NULL
         ),
         nodes (id, depth) AS (
           SELECT id, 0 FROM pages WHERE slug = $1 AND deleted_at IS NULL
           UNION
           SELECT s.next_id, s.depth FROM (${step} WHERE n.depth < $2) s
         )
         SELECT DISTINCT e.from_slug, e.to_slug
         FROM live_edges e
         JOIN nodes nf ON nf.id = e.from_page_id
         JOIN nodes nt ON nt.id = e.to_page_id
         LIMIT 2000`,
        [slug, d],
      );
      return res.rows.map((r) => ({ from_slug: String(r.from_slug), to_slug: String(r.to_slug) }));
    },

    async recentPages({ days, limit }) {
      const dd = Math.min(Math.max(Number(days) || 30, 1), 365);
      const n = Math.min(Math.max(Number(limit) || 10, 1), 200);
      const res = await db.query(
        `SELECT slug, kind, title, frontmatter, updated_at FROM pages
         WHERE deleted_at IS NULL AND updated_at > now() - make_interval(days => $1)
         ORDER BY updated_at DESC LIMIT $2`,
        [dd, n],
      );
      return res.rows.map((r) => ({
        slug: String(r.slug),
        title: String(r.title),
        type: pageType(r),
        updated_at: iso(r.updated_at),
      }));
    },

    async sweepMentions({ limit, dryRun }) {
      const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
      // The gazetteer is small (typed pages only), so it is cheap to rebuild per
      // call and always current — but only if the query asks for those pages:
      // selecting every live page read the whole vault into memory to build a
      // list of a few hundred names. The prefixes come from mentions.ts, which
      // owns them, so the filter cannot drift from what buildGazetteer keeps.
      // Shortest slug first because that is the tie-break buildGazetteer uses
      // for an ambiguous name, so the cap drops the names it would drop anyway.
      const named = await db.query(
        `SELECT id, slug, title, frontmatter->'aliases' AS aliases FROM pages
         WHERE deleted_at IS NULL AND slug LIKE ANY($1::text[])
         ORDER BY length(slug), slug LIMIT ${GAZETTEER_LIMIT}`,
        [GAZETTEER_PREFIXES.map((p) => `${p}%`)],
      );
      const gazetteer = buildGazetteer(
        named.rows.map((r) => ({
          id: Number(r.id),
          slug: String(r.slug),
          title: String(r.title),
          aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
        })),
      );
      const slugById = new Map(named.rows.map((r) => [Number(r.id), String(r.slug)]));

      // slug comes along because slugById only knows the gazetteer's pages now;
      // the page being scanned is usually not one of them.
      const batch = await db.query(
        `SELECT id, slug, body FROM pages WHERE deleted_at IS NULL
         ORDER BY mentions_scanned_at NULLS FIRST, id LIMIT $1`,
        [n],
      );
      const pairs: { from_slug: string; to_slug: string }[] = [];
      let edgesAdded = 0;
      for (const row of batch.rows) {
        const fromId = Number(row.id);
        for (const toId of findMentions(String(row.body), gazetteer)) {
          if (toId === fromId) continue; // self-link guard
          pairs.push({
            from_slug: String(row.slug),
            to_slug: slugById.get(toId) ?? String(toId),
          });
          if (dryRun) continue;
          // The (from, to, lane) primary key makes this idempotent, and the
          // declared lane is never touched: a real link always wins in the UI.
          const res = await db.query(
            `INSERT INTO edges (from_page_id, to_page_id, lane, kind)
             VALUES ($1, $2, 'auto', 'mention') ON CONFLICT DO NOTHING RETURNING 1`,
            [fromId, toId],
          );
          edgesAdded += res.rows.length;
        }
        if (!dryRun) {
          await db.query("UPDATE pages SET mentions_scanned_at = now() WHERE id = $1", [fromId]);
        }
      }
      const left = await db.query(
        `SELECT count(*)::int AS n FROM pages
         WHERE deleted_at IS NULL AND mentions_scanned_at IS NULL`,
      );
      return {
        scanned: batch.rows.length,
        edgesAdded,
        remaining: Number(left.rows[0].n),
        pairs,
      };
    },

    async clearAutoEdges() {
      const res = await db.query("DELETE FROM edges WHERE lane = 'auto' RETURNING 1");
      await db.query("UPDATE pages SET mentions_scanned_at = NULL");
      return { removed: res.rows.length };
    },

    async exportBatch({ afterSlug, limit }) {
      const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const res = await db.query(
        `SELECT slug, title, body, frontmatter FROM pages
         WHERE deleted_at IS NULL AND ($1::text IS NULL OR slug > $1)
         ORDER BY slug LIMIT $2`,
        [afterSlug ?? null, n],
      );
      return res.rows.map((r) => ({
        slug: String(r.slug),
        title: String(r.title),
        body: String(r.body),
        frontmatter: (r.frontmatter as Record<string, unknown>) ?? {},
      }));
    },

    async pageCount() {
      const res = await db.query("SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL");
      return Number(res.rows[0].n);
    },
  };
}
