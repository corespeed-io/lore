// Minimal DB seam: one query shape + one transaction shape, implemented by
// node-postgres in production and PGlite in tests. Keep this file free of any
// driver import so the store stays testable without a server.

import { MEMORY_DDL, MEMORY_MIGRATION } from "./memory/ddl";
import { migrateMemoryNamespace } from "./memory/projection";

export type Query = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface Db {
  query: Query;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
}

export interface BrainMeta {
  embeddingModel: string;
  embeddingDim: number;
}

const SCHEMA_VERSION = 5;

// ONE definition, used by both the bootstrap in initSchema and the ddl list
// below. Two copies drifted once already: the bootstrap created `meta` without
// maintenance_lease, which made the ddl copy a no-op and left a FRESH database
// claiming schema_version 3 while missing a v3 column.
const META_DDL = `CREATE TABLE IF NOT EXISTS meta (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  embedding_model TEXT NOT NULL,
  embedding_dim INT NOT NULL,
  schema_version INT NOT NULL,
  -- Compare-and-set lease: one mention sweep at a time, even if two schedulers
  -- fire at once.
  maintenance_lease TIMESTAMPTZ
)`;

// The candidate filter the forward-reference lookup uses (store.ts), and the
// expression its index is built on — ONE definition so query and index cannot
// diverge into a seq scan. ref_norm was written by normalizeRef() in JS, so it is
// already NFKC-folded and lowercased and SQL only drops the path prefix and the
// separators. Coarser than normalizeSlugish, which mostly means it OVER-selects
// and resolveRef() decides.
// It does NOT always agree with its JS half (refKey in store.ts), and an earlier
// version of this comment wrongly promised it could not disagree: JS strips the
// path BEFORE folding quotes and case, this strips it after ([[qq/'Quoted Uniq']]
// keys differently on the two sides), and SQL lower() differs from JS
// toLowerCase() on a dotted 'İ' or a ligature — the same gap pages.basename
// carries below. A disagreement can only make a parked ref MISS its page (it
// stays parked, and list_broken_links names it), never point at the wrong one.
// The real fix is a ref_key column written by refKey() in JS, like ref_norm: a
// SCHEMA_VERSION bump plus a rebuild of pending_links_key, deliberately not
// smuggled in as a silent index-expression change (IF NOT EXISTS keys on the
// NAME, so an existing database would keep the old index and seq-scan instead).
export const REF_KEY_SQL =
  "regexp_replace(regexp_replace(ref_norm, '^.*/', ''), '[-_ ]+', '', 'g')";

function ddl(dim: number): { sql: string; optional?: boolean }[] {
  return [
    { sql: "CREATE EXTENSION IF NOT EXISTS vector" },
    { sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm" },
    { sql: META_DDL },
    {
      sql: `CREATE TABLE IF NOT EXISTS pages (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'memory')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        frontmatter JSONB NOT NULL DEFAULT '{}',
        content_hash TEXT NOT NULL,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- When the mention sweep last looked at this page; NULL means never.
        mentions_scanned_at TIMESTAMPTZ,
        -- The last slug segment with separators folded to spaces, so a ref typed
        -- as [[Some Note]] finds notes/some-note. normalizeSlugish() is the JS
        -- half of this comparison; the two MUST agree.
        -- KNOWN GAP, deliberately not closed: SQL has no NFKC, so this mirrors
        -- lower() + separator folding only, while normalizeSlugish also folds
        -- compatibility forms and strips surrounding quotes. A FILENAME holding a
        -- ligature (ﬁ), a fullwidth char (Ｍ) or a quote is therefore unreachable
        -- through the basename arm: the ref normalizes to the plain form and this
        -- column keeps the raw one. macOS NFD filenames are the case a real Mac
        -- vault import hits, so resolveRef() compares the NFD form of the ref too
        -- (store.ts) — that half IS covered. Closing the rest means making
        -- basename a plain column written by normalizeSlugish in TS: a
        -- SCHEMA_VERSION bump, a full backfill through the app, and every write
        -- path setting it. Not worth that until someone hits it.
        basename TEXT GENERATED ALWAYS AS (btrim(regexp_replace(lower(regexp_replace(slug, '^.*/', '')), '[-_]+', ' ', 'g'))) STORED,
        fts tsvector GENERATED ALWAYS AS (
          to_tsvector(
            'simple',
            left(
              title || ' ' ||
              coalesce(frontmatter->>'aliases', '') || ' ' ||
              coalesce(frontmatter->>'tags', '') || ' ' ||
              body,
              500000
            )
          )
        ) STORED
      )`,
    },
    { sql: "CREATE INDEX IF NOT EXISTS pages_fts ON pages USING gin (fts)" },
    { sql: "CREATE INDEX IF NOT EXISTS pages_updated ON pages (updated_at DESC)" },
    { sql: "CREATE INDEX IF NOT EXISTS pages_basename ON pages (basename)" },
    // The sweep asks for the least-recently-scanned pages.
    {
      sql: "CREATE INDEX IF NOT EXISTS pages_mentions_scanned ON pages (mentions_scanned_at NULLS FIRST)",
    },
    // Containment lookups against frontmatter->'aliases'.
    { sql: "CREATE INDEX IF NOT EXISTS pages_frontmatter ON pages USING gin (frontmatter)" },
    {
      sql: `CREATE TABLE IF NOT EXISTS chunks (
        page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        seq INT NOT NULL,
        text TEXT NOT NULL,
        embedding vector(${dim}) NOT NULL,
        PRIMARY KEY (page_id, seq)
      )`,
    },
    // HNSW is a speed-up, not a correctness requirement; environments whose
    // pgvector build lacks it (or tiny test DBs) fall back to a seq scan.
    {
      sql: "CREATE INDEX IF NOT EXISTS chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)",
      optional: true,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS edges (
        from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        to_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        lane TEXT NOT NULL DEFAULT 'declared' CHECK (lane IN ('declared', 'auto')),
        kind TEXT NOT NULL DEFAULT 'wikilink',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (from_page_id, to_page_id, lane)
      )`,
    },
    { sql: "CREATE INDEX IF NOT EXISTS edges_to ON edges (to_page_id)" },
    {
      sql: `CREATE TABLE IF NOT EXISTS pending_links (
        from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        target_ref TEXT NOT NULL,
        ref_norm TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (from_page_id, target_ref)
      )`,
    },
    // ref_norm is written by normalizeRef() in JS (NFKC is not available in
    // SQL), so it cannot be a generated column.
    { sql: "CREATE INDEX IF NOT EXISTS pending_links_norm ON pending_links (ref_norm)" },
    // ...and the coarse key the forward-reference candidate filter matches on,
    // which runs on every page write: without this it is a seq scan over every
    // parked ref in the vault, per put.
    { sql: `CREATE INDEX IF NOT EXISTS pending_links_key ON pending_links ((${REF_KEY_SQL}))` },
    // Agent Memory (v4). Declared next to everything else so there is exactly
    // one list that owns the schema.
    ...MEMORY_DDL,
  ];
}

// Idempotent init. Order matters: an EXISTING database must be migrated before
// the DDL below runs, because that DDL indexes columns (basename) that older
// databases do not have yet — indexing a missing column throws and the whole
// init fails. So: bootstrap meta, migrate if needed, then create/verify the
// rest, and LAST repair the reserved memory/ namespace.
//
// The meta row pins the embedding space: a model or dimension change is a
// re-embed event (2026-07-22 lesson: spaces don't mix), so we fail loud instead
// of silently writing mixed-space vectors.
//
// Why the namespace repair is the last thing here and not a `from < N` step in
// the version-keyed list below. It is a DATA repair, not a schema change: it must
// run on every database that has ever been opened, including one whose
// schema_version already reads current because a dump was restored into it or
// because somebody set the column by hand. A privacy boundary keyed on an integer
// has a second path around it; this one has none, because there is no way to get a
// Store (src/server/local.ts) without awaiting this function, and it THROWS rather
// than return while any page in the reserved namespace is still readable. It is
// also why it runs after the DDL loop rather than inside migrate(): the memory
// tables it reads are created there for a fresh database. See
// migrateMemoryNamespace in memory/projection.ts for the bound on its work.
export async function initSchema(db: Db, meta: BrainMeta): Promise<void> {
  if (!Number.isInteger(meta.embeddingDim) || meta.embeddingDim < 1 || meta.embeddingDim > 16000) {
    throw new Error(`invalid embedding dim: ${meta.embeddingDim}`);
  }
  await db.query(META_DDL);
  const existing = await db.query(
    "SELECT embedding_model, embedding_dim, schema_version FROM meta WHERE id = 1",
  );
  const row = existing.rows[0] as
    | { embedding_model: string; embedding_dim: number; schema_version: number }
    | undefined;
  if (row) {
    if (
      row.embedding_model !== meta.embeddingModel ||
      Number(row.embedding_dim) !== meta.embeddingDim
    ) {
      throw new Error(
        `embedding space mismatch: database is ${row.embedding_model}@${row.embedding_dim}, env wants ${meta.embeddingModel}@${meta.embeddingDim}. Changing models requires a re-embed: truncate chunks, update meta, and re-put pages (or start a fresh database).`,
      );
    }
    await migrate(db, Number(row.schema_version) || 1);
  }
  for (const stmt of ddl(meta.embeddingDim)) {
    try {
      await db.query(stmt.sql);
    } catch (e) {
      if (!stmt.optional) throw e;
    }
  }
  if (!row) {
    await db.query(
      "INSERT INTO meta (id, embedding_model, embedding_dim, schema_version) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [meta.embeddingModel, meta.embeddingDim, SCHEMA_VERSION],
    );
  }
  await migrateMemoryNamespace(db);
}

// CREATE TABLE IF NOT EXISTS cannot change an existing table, so a column that
// gains a definition (the fts expression) or appears late (basename, ref_norm)
// needs an explicit step. Keyed on meta.schema_version and idempotent.
async function migrate(db: Db, from: number): Promise<void> {
  if (from >= SCHEMA_VERSION) return;
  if (from < 2) {
    // Aliases and the last slug segment become resolvable and searchable.
    await db.query("ALTER TABLE pages DROP COLUMN IF EXISTS basename");
    await db.query(
      `ALTER TABLE pages ADD COLUMN basename TEXT GENERATED ALWAYS AS
       (btrim(regexp_replace(lower(regexp_replace(slug, '^.*/', '')), '[-_]+', ' ', 'g'))) STORED`,
    );
    await db.query("ALTER TABLE pages DROP COLUMN IF EXISTS fts");
    await db.query(
      `ALTER TABLE pages ADD COLUMN fts tsvector GENERATED ALWAYS AS (
         to_tsvector('simple', left(title || ' ' ||
           coalesce(frontmatter->>'aliases', '') || ' ' ||
           coalesce(frontmatter->>'tags', '') || ' ' || body, 500000))
       ) STORED`,
    );
    await db.query(
      "ALTER TABLE pending_links ADD COLUMN IF NOT EXISTS ref_norm TEXT NOT NULL DEFAULT ''",
    );
    // Approximate backfill: these rows are transient (rewritten whenever the
    // referring page is re-put) and lower(trim()) matches normalizeRef for
    // everything but exotic Unicode.
    await db.query(
      "UPDATE pending_links SET ref_norm = lower(btrim(target_ref)) WHERE ref_norm = ''",
    );
  }
  if (from < 3) {
    await db.query("ALTER TABLE meta ADD COLUMN IF NOT EXISTS maintenance_lease TIMESTAMPTZ");
    await db.query("ALTER TABLE pages ADD COLUMN IF NOT EXISTS mentions_scanned_at TIMESTAMPTZ");
  }
  if (from < 4) {
    // Agent Memory tables. These are additive — no existing table changes
    // shape — so the same statements serve a fresh database and an upgrade.
    for (const stmt of MEMORY_MIGRATION) await db.query(stmt.sql);
  }
  if (from < 5) {
    // The multi-tenant memory scope is gone: one brain, one user, one scope.
    // Without this, every memory written at 'thread' or 'agent' scope would be
    // stranded — the reads now look only at 'vault', so the rows would still be
    // there and never come back. Data loss by invisibility is still data loss.
    await db.query(
      "UPDATE memory_items SET scope_type = 'vault', scope_id = NULL WHERE scope_type <> 'vault'",
    );
  }
  await db.query("UPDATE meta SET schema_version = $1 WHERE id = 1", [SCHEMA_VERSION]);
}
