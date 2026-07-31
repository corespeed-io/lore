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
  expect(Number((await one("SELECT schema_version FROM meta")).schema_version)).toBe(2);
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
  expect(Number(row.schema_version)).toBe(2);
  await pg.close();
});
