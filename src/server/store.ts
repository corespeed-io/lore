// The standalone brain: pages + chunks + edges over one Postgres, hybrid
// retrieval (vector + FTS + trigram → RRF), wikilink graph with forward-
// reference resolution. Single-tenant by design — no sources, no scopes.

import type { Db, Query } from "./db";
import { type EmbedFn, chunkBody, extractWikilinks } from "./pipeline";

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
const ARM_LIMIT = 40;
// ANN candidates pulled before per-page max-pool: multi-chunk pages and
// soft-deleted rows both eat slots, so over-fetch well past ARM_LIMIT.
const ANN_OVERFETCH = ARM_LIMIT * 5;
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
function likeLiteral(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

export interface Store {
  putPage(args: PutPageArgs): Promise<{ slug: string; unchanged: boolean }>;
  remember(args: {
    memory: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ slug: string }>;
  deletePage(args: { slug: string }): Promise<{ slug: string; deleted: true }>;
  restorePage(args: { slug: string }): Promise<{ slug: string; restored: true }>;
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
}

export function createStore(db: Db, embed: EmbedFn): Store {
  // Resolve a wikilink ref (slug or title) to a page id within one transaction.
  async function resolveRef(q: Query, ref: string): Promise<number | null> {
    const bySlug = await q("SELECT id FROM pages WHERE slug = $1 AND deleted_at IS NULL", [ref]);
    if (bySlug.rows.length) return Number(bySlug.rows[0].id);
    const byTitle = await q(
      "SELECT id FROM pages WHERE lower(title) = lower($1) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
      [ref],
    );
    return byTitle.rows.length ? Number(byTitle.rows[0].id) : null;
  }

  async function putPage(args: PutPageArgs): Promise<{ slug: string; unchanged: boolean }> {
    const slug = args.slug?.trim();
    if (!slug || !SLUG_RE.test(slug)) {
      throw new Error(
        `invalid slug: must be non-empty, no whitespace or []|# (got ${JSON.stringify(args.slug)})`,
      );
    }
    if (typeof args.body !== "string") throw new Error("body must be a string");
    if (args.body.length > MAX_BODY_CHARS) {
      throw new Error(
        `body too large: ${args.body.length} chars exceeds the ${MAX_BODY_CHARS} limit`,
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
    const title = (args.title ?? "").trim() || titleFromBody(args.body, slug);
    // Hash every field a write can change - kind included, or flipping a
    // page between note and memory hashes the same and gets skipped as
    // "unchanged". JSON-encoding the tuple keeps field boundaries clear.
    const hash = await sha256Hex(JSON.stringify([kind, title, args.body, frontmatter]));

    if (existing && existing.content_hash === hash) {
      return { slug, unchanged: true }; // idempotent re-ingest: skip embedding entirely
    }

    // Embed BEFORE writing: a failed embed leaves nothing half-written, so no
    // compensation machinery. ponytail: couples writes to embeddings-provider
    // uptime; add an indexed_at watermark + re-embed sweep if that ever bites.
    const chunks = chunkBody(args.body);
    const vectors = await embed(chunks);

    const refs = extractWikilinks(args.body);
    const related = Array.isArray(frontmatter.related_ids)
      ? (frontmatter.related_ids as unknown[]).filter((r): r is string => typeof r === "string")
      : [];

    await db.tx(async (q) => {
      const up = await q(
        `INSERT INTO pages (slug, kind, title, body, frontmatter, content_hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (slug) DO UPDATE SET
           kind = EXCLUDED.kind, title = EXCLUDED.title, body = EXCLUDED.body,
           frontmatter = EXCLUDED.frontmatter, content_hash = EXCLUDED.content_hash,
           deleted_at = NULL, updated_at = now()
         RETURNING id, title`,
        [slug, kind, title, args.body, JSON.stringify(frontmatter), hash],
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
      for (const ref of related) {
        const id = await resolveRef(q, ref);
        if (id !== null && id !== pageId) targets.set(id, "related");
        else if (id === null) {
          await q(
            "INSERT INTO pending_links (from_page_id, target_ref) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [pageId, ref],
          );
        }
      }
      for (const ref of refs) {
        const id = await resolveRef(q, ref);
        if (id !== null && id !== pageId) targets.set(id, "wikilink");
        else if (id === null) {
          await q(
            "INSERT INTO pending_links (from_page_id, target_ref) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [pageId, ref],
          );
        }
      }
      for (const [toId, edgeKind] of targets) {
        await q(
          "INSERT INTO edges (from_page_id, to_page_id, lane, kind) VALUES ($1, $2, 'declared', $3) ON CONFLICT DO NOTHING",
          [pageId, toId, edgeKind],
        );
      }

      // Forward references: pages that wiki-linked this slug/title before it
      // existed now get their edge, and the pending row is consumed.
      const pend = await q(
        "SELECT from_page_id, target_ref FROM pending_links WHERE lower(target_ref) IN (lower($1), lower($2))",
        [slug, up.rows[0].title as string],
      );
      for (const row of pend.rows) {
        const fromId = Number(row.from_page_id);
        if (fromId === pageId) continue;
        await q(
          "INSERT INTO edges (from_page_id, to_page_id, lane, kind) VALUES ($1, $2, 'declared', 'wikilink') ON CONFLICT DO NOTHING",
          [fromId, pageId],
        );
        await q("DELETE FROM pending_links WHERE from_page_id = $1 AND target_ref = $2", [
          fromId,
          row.target_ref,
        ]);
      }
    });
    return { slug, unchanged: false };
  }

  return {
    putPage,

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

    async deletePage({ slug }) {
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

    async restorePage({ slug }) {
      const res = await db.query(
        `SELECT title, body, kind, frontmatter FROM pages
         WHERE slug = $1 AND deleted_at IS NOT NULL`,
        [slug],
      );
      const row = res.rows[0];
      if (!row) throw new Error(`not_found: no deleted page with slug ${slug}`);
      // Un-delete FIRST so the re-put sees the row as prior state, then re-put to
      // rebuild the chunks that deletePage dropped. content_hash is cleared
      // because otherwise the re-put matches the stored hash, short-circuits as
      // "unchanged", and leaves the page alive with zero chunks -- invisible to
      // the vector arm forever.
      await db.query(
        "UPDATE pages SET deleted_at = NULL, content_hash = '', updated_at = now() WHERE slug = $1",
        [slug],
      );
      await putPage({
        slug,
        title: String(row.title),
        body: String(row.body),
        kind: row.kind as PageKind,
        frontmatter: (row.frontmatter as Record<string, unknown>) ?? {},
      });
      return { slug, restored: true as const };
    },

    async getPage({ slug, fuzzy }) {
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
        res = await db.query(
          `SELECT ${cols} FROM pages WHERE deleted_at IS NULL AND title ILIKE '%' || $1 || '%'
           ORDER BY length(title) ASC, updated_at DESC LIMIT 1`,
          [slug],
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

    async getBacklinks({ slug }) {
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

    async traverseGraph({ slug, depth, direction }) {
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

    async pageCount() {
      const res = await db.query("SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL");
      return Number(res.rows[0].n);
    },
  };
}
