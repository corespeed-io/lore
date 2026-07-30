// Minimal DB seam: one query shape + one transaction shape, implemented by
// node-postgres in production and PGlite in tests. Keep this file free of any
// driver import so the store stays testable without a server.

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

const SCHEMA_VERSION = 1;

function ddl(dim: number): { sql: string; optional?: boolean }[] {
  return [
    { sql: "CREATE EXTENSION IF NOT EXISTS vector" },
    { sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm" },
    {
      sql: `CREATE TABLE IF NOT EXISTS meta (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        embedding_model TEXT NOT NULL,
        embedding_dim INT NOT NULL,
        schema_version INT NOT NULL
      )`,
    },
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
        fts tsvector GENERATED ALWAYS AS (
          to_tsvector('simple', left(title || ' ' || body, 500000))
        ) STORED
      )`,
    },
    { sql: "CREATE INDEX IF NOT EXISTS pages_fts ON pages USING gin (fts)" },
    { sql: "CREATE INDEX IF NOT EXISTS pages_updated ON pages (updated_at DESC)" },
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
        PRIMARY KEY (from_page_id, target_ref)
      )`,
    },
    { sql: "CREATE INDEX IF NOT EXISTS pending_links_ref ON pending_links (lower(target_ref))" },
  ];
}

// Idempotent init. The meta row pins the embedding space: a model or dimension
// change is a re-embed event (2026-07-22 lesson: spaces don't mix), so we fail
// loud instead of silently writing mixed-space vectors.
export async function initSchema(db: Db, meta: BrainMeta): Promise<void> {
  if (!Number.isInteger(meta.embeddingDim) || meta.embeddingDim < 1 || meta.embeddingDim > 16000) {
    throw new Error(`invalid embedding dim: ${meta.embeddingDim}`);
  }
  for (const stmt of ddl(meta.embeddingDim)) {
    try {
      await db.query(stmt.sql);
    } catch (e) {
      if (!stmt.optional) throw e;
    }
  }
  const existing = await db.query("SELECT embedding_model, embedding_dim FROM meta WHERE id = 1");
  if (existing.rows.length === 0) {
    await db.query(
      "INSERT INTO meta (id, embedding_model, embedding_dim, schema_version) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [meta.embeddingModel, meta.embeddingDim, SCHEMA_VERSION],
    );
    return;
  }
  const row = existing.rows[0] as { embedding_model: string; embedding_dim: number };
  if (
    row.embedding_model !== meta.embeddingModel ||
    Number(row.embedding_dim) !== meta.embeddingDim
  ) {
    throw new Error(
      `embedding space mismatch: database is ${row.embedding_model}@${row.embedding_dim}, env wants ${meta.embeddingModel}@${meta.embeddingDim}. Changing models requires a re-embed: truncate chunks, update meta, and re-put pages (or start a fresh database).`,
    );
  }
}
