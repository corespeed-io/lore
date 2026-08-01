import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";

const DIM = 8;

function pgliteDb(lite: PGlite): Db {
  const q: Query = async (text, params) => {
    const res = await lite.query(text, params as unknown[]);
    return { rows: res.rows as Record<string, unknown>[] };
  };
  return {
    query: q,
    async tx(fn) {
      const out = await lite.transaction((t) =>
        fn(async (text, params) => {
          const res = await t.query(text, params as unknown[]);
          return { rows: res.rows as Record<string, unknown>[] };
        }),
      );
      return out as Awaited<ReturnType<typeof fn>>;
    },
  };
}

// The v1 shape, verbatim: no basename, no ref_norm, and an fts expression that
// ignores frontmatter. CREATE TABLE IF NOT EXISTS cannot fix any of that, so
// this is the case initSchema has to migrate.
const V1 = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE meta (id INT PRIMARY KEY DEFAULT 1 CHECK (id=1), embedding_model TEXT NOT NULL,
  embedding_dim INT NOT NULL, schema_version INT NOT NULL);
INSERT INTO meta VALUES (1,'fake',${DIM},1);
CREATE TABLE pages (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','memory')), title TEXT NOT NULL,
  body TEXT NOT NULL, frontmatter JSONB NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
  deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(title || ' ' || body, 500000))) STORED);
CREATE INDEX pages_fts ON pages USING gin (fts);
CREATE TABLE chunks (page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, seq INT NOT NULL,
  text TEXT NOT NULL, embedding vector(${DIM}) NOT NULL, PRIMARY KEY (page_id, seq));
CREATE TABLE edges (from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  lane TEXT NOT NULL DEFAULT 'declared', kind TEXT NOT NULL DEFAULT 'wikilink',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (from_page_id,to_page_id,lane));
CREATE TABLE pending_links (from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_ref TEXT NOT NULL, PRIMARY KEY (from_page_id,target_ref));
INSERT INTO pages (slug,title,body,frontmatter,content_hash) VALUES
  ('people/robert-smith','Robert Smith','bio','{"aliases":["Bob"]}','h1'),
  ('notes/old-ref','Old Ref','waits for [[Bob]]','{}','h2');
INSERT INTO pending_links (from_page_id,target_ref) SELECT id,'Bob' FROM pages WHERE slug='notes/old-ref';
`;

test("a v1 database migrates in place, keeping its data", async () => {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await pg.exec(V1);

  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });

  const one = async (sql: string) => (await db.query(sql)).rows[0] as Record<string, unknown>;
  expect(Number((await one("SELECT schema_version FROM meta")).schema_version)).toBe(4);
  // separators folded, so a ref typed "Robert Smith" can match the filename
  expect((await one("SELECT basename FROM pages WHERE slug='people/robert-smith'")).basename).toBe(
    "robert smith",
  );
  expect((await one("SELECT ref_norm FROM pending_links")).ref_norm).toBe("bob");
  // the fts column was redefined, so aliases are searchable
  expect(
    (
      await one(
        "SELECT fts @@ websearch_to_tsquery('simple','Bob') AS hit FROM pages WHERE slug='people/robert-smith'",
      )
    ).hit,
  ).toBe(true);
  expect(Number((await one("SELECT count(*)::int AS n FROM pages")).n)).toBe(2);
  // v3 columns landed too: the sweep watermark and the maintenance lease
  expect(
    (await one("SELECT mentions_scanned_at FROM pages LIMIT 1")).mentions_scanned_at,
  ).toBeNull();
  expect((await one("SELECT maintenance_lease FROM meta")).maintenance_lease).toBeNull();

  // and it is idempotent: a second init is a no-op, not a re-migration
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  expect(Number((await one("SELECT count(*)::int AS n FROM pages")).n)).toBe(2);
  await pg.close();
});

test("a fresh database initializes at the current version", async () => {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  const row = (await db.query("SELECT schema_version FROM meta")).rows[0] as {
    schema_version: number;
  };
  expect(Number(row.schema_version)).toBe(4);
  await pg.close();
});

test("a fresh database really has every column its schema_version claims", async () => {
  // The drift this catches: `meta` was defined twice (bootstrap + ddl list), so
  // a fresh database got the 4-column bootstrap, the ddl copy became a no-op,
  // and initSchema stamped schema_version 3 onto a table missing a v3 column.
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });

  const cols = async (table: string) =>
    (
      await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [
        table,
      ])
    ).rows.map((r) => String(r.column_name));

  expect(await cols("meta")).toEqual(
    expect.arrayContaining([
      "id",
      "embedding_model",
      "embedding_dim",
      "schema_version",
      "maintenance_lease",
    ]),
  );
  expect(await cols("pages")).toEqual(
    expect.arrayContaining(["basename", "fts", "mentions_scanned_at", "deleted_at"]),
  );
  expect(await cols("pending_links")).toEqual(expect.arrayContaining(["ref_norm"]));
  // v4: the memory layers exist on a fresh database, not only after a migration
  expect(await cols("conversation_events")).toEqual(
    expect.arrayContaining(["thread_id", "sequence", "idempotency_key", "content_hash"]),
  );
  expect(await cols("thread_summaries")).toEqual(
    expect.arrayContaining(["version", "covered_from_sequence", "covered_through_sequence"]),
  );
  expect(await cols("memory_items")).toEqual(
    expect.arrayContaining([
      "scope_type",
      "memory_type",
      "memory_key",
      "status",
      "valid_from",
      "valid_to",
      "supersedes_id",
      "projection_page_id",
      "projection_status",
      "fingerprint",
    ]),
  );
  expect(await cols("memory_sources")).toEqual(expect.arrayContaining(["event_id"]));
  expect(await cols("memory_revisions")).toEqual(expect.arrayContaining(["operation"]));
  expect(await cols("extraction_checkpoints")).toEqual(
    expect.arrayContaining(["last_extracted_sequence"]),
  );
  await pg.close();
});

// The v3 shape: everything the previous release created, and none of the memory
// tables. This is what a deployed brain looks like the moment before v4.
const V3 = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE meta (id INT PRIMARY KEY DEFAULT 1 CHECK (id=1), embedding_model TEXT NOT NULL,
  embedding_dim INT NOT NULL, schema_version INT NOT NULL, maintenance_lease TIMESTAMPTZ);
INSERT INTO meta VALUES (1,'fake',${DIM},3,NULL);
CREATE TABLE pages (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','memory')), title TEXT NOT NULL,
  body TEXT NOT NULL, frontmatter JSONB NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
  deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), mentions_scanned_at TIMESTAMPTZ,
  basename TEXT GENERATED ALWAYS AS (btrim(regexp_replace(lower(regexp_replace(slug,'^.*/','')),'[-_]+',' ','g'))) STORED,
  fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(title || ' ' ||
    coalesce(frontmatter->>'aliases','') || ' ' || coalesce(frontmatter->>'tags','') || ' ' || body, 500000))) STORED);
CREATE INDEX pages_fts ON pages USING gin (fts);
CREATE INDEX pages_basename ON pages (basename);
CREATE TABLE chunks (page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, seq INT NOT NULL,
  text TEXT NOT NULL, embedding vector(${DIM}) NOT NULL, PRIMARY KEY (page_id, seq));
CREATE TABLE edges (from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  lane TEXT NOT NULL DEFAULT 'declared' CHECK (lane IN ('declared','auto')),
  kind TEXT NOT NULL DEFAULT 'wikilink', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id,to_page_id,lane));
CREATE TABLE pending_links (from_page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_ref TEXT NOT NULL, ref_norm TEXT NOT NULL DEFAULT '', PRIMARY KEY (from_page_id,target_ref));
INSERT INTO pages (slug,title,body,frontmatter,content_hash) VALUES
  ('people/robert-smith','Robert Smith','bio','{"aliases":["Bob"]}','h1'),
  ('notes/links-bob','Links Bob','see [[Bob]]','{}','h2');
INSERT INTO edges (from_page_id,to_page_id,lane) SELECT b.id, a.id, 'declared'
  FROM pages a, pages b WHERE a.slug='people/robert-smith' AND b.slug='notes/links-bob';
INSERT INTO edges (from_page_id,to_page_id,lane) SELECT b.id, a.id, 'auto'
  FROM pages a, pages b WHERE a.slug='people/robert-smith' AND b.slug='notes/links-bob';
INSERT INTO pending_links (from_page_id,target_ref,ref_norm) SELECT id,'Nobody','nobody'
  FROM pages WHERE slug='notes/links-bob';
`;

test("a real v3 database upgrades to v4 with everything intact", async () => {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await pg.exec(V3);

  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });

  const one = async (sql: string) => (await db.query(sql)).rows[0] as Record<string, unknown>;
  expect(Number((await one("SELECT schema_version FROM meta")).schema_version)).toBe(4);

  // Nothing the previous release owned may be disturbed by an additive upgrade.
  expect(Number((await one("SELECT count(*)::int AS n FROM pages")).n)).toBe(2);
  expect(Number((await one("SELECT count(*)::int AS n FROM edges WHERE lane='declared'")).n)).toBe(
    1,
  );
  expect(Number((await one("SELECT count(*)::int AS n FROM edges WHERE lane='auto'")).n)).toBe(1);
  expect(Number((await one("SELECT count(*)::int AS n FROM pending_links")).n)).toBe(1);
  expect((await one("SELECT basename FROM pages WHERE slug='people/robert-smith'")).basename).toBe(
    "robert smith",
  );
  // alias-aware FTS from v2 still works after the v4 step
  expect(
    (
      await one(
        "SELECT fts @@ websearch_to_tsquery('simple','Bob') AS hit FROM pages WHERE slug='people/robert-smith'",
      )
    ).hit,
  ).toBe(true);

  // And the new layers are usable, not merely present.
  const tables = (
    await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
         ('threads','conversation_events','thread_summaries','memory_items',
          'memory_sources','memory_revisions','extraction_checkpoints','procedure_episodes')`,
    )
  ).rows.map((r) => String(r.table_name));
  expect(tables.sort()).toEqual([
    "conversation_events",
    "extraction_checkpoints",
    "memory_items",
    "memory_revisions",
    "memory_sources",
    "procedure_episodes",
    "thread_summaries",
    "threads",
  ]);

  // Idempotent: running init again changes nothing.
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  expect(Number((await one("SELECT count(*)::int AS n FROM pages")).n)).toBe(2);
  await pg.close();
});
