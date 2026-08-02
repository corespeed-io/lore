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
  expect(Number((await one("SELECT schema_version FROM meta")).schema_version)).toBe(5);
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
  expect(Number(row.schema_version)).toBe(5);
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
-- A projection an older release wrote for a THREAD-scoped memory, under that
-- release's slug shape. On a v3 database there are no memory tables at all, so
-- nothing can claim it: this is the leak a deployed brain carries across the
-- upgrade, and initSchema has to close it without an operator doing anything.
INSERT INTO pages (slug,kind,title,body,content_hash) VALUES
  ('memory/scoped/mem-legacy-1','memory','billing email',
   'billing email is finance@example.com','h3');
`;

test("a real v3 database upgrades to v4 with everything intact", async () => {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await pg.exec(V3);

  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });

  const one = async (sql: string) => (await db.query(sql)).rows[0] as Record<string, unknown>;
  expect(Number((await one("SELECT schema_version FROM meta")).schema_version)).toBe(5);

  // Nothing the previous release owned may be disturbed by an additive upgrade.
  expect(Number((await one("SELECT count(*)::int AS n FROM pages")).n)).toBe(3);
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
  expect(Number((await one("SELECT count(*)::int AS n FROM pages")).n)).toBe(3);
  await pg.close();
});

test("opening a v3 brain sweeps the reserved namespace, and the ORDER is what makes it possible", async () => {
  // Two things at once, because they are the same ordering constraint.
  //
  // 1. The repair is not optional and not on a scheduler. Before this, purging
  //    legacy projections was reachable only from POST /api/maintenance, which
  //    needs the write bearer and which nothing calls on its own — so a brain
  //    upgraded on Monday served every thread's memories to every holder of the
  //    shared read token until an operator wired a cron. initSchema is on the one
  //    path to a Store, so putting it here means a brain that has been OPENED has
  //    been swept.
  // 2. The sweep reads memory_items, and on a v3 database that table does not
  //    exist until the v3->v4 migration step creates it. So it must run AFTER
  //    migrate() — the mirror image of the constraint that migrations run BEFORE
  //    the DDL block. Move it earlier and this test fails with
  //    `relation "memory_items" does not exist`, which is the whole point of
  //    pinning it.
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await pg.exec(V3);

  // Pre-upgrade, this is a live page on the shared read surface.
  const before = await db.query(
    "SELECT deleted_at FROM pages WHERE slug = 'memory/scoped/mem-legacy-1'",
  );
  expect(before.rows[0].deleted_at).toBeNull();

  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });

  // No page in the reserved namespace is readable. Asserted as the invariant over
  // the whole namespace rather than about one slug, so a second legacy shape
  // cannot pass by not being listed.
  const live = await db.query(
    "SELECT slug FROM pages WHERE slug LIKE 'memory/%' AND deleted_at IS NULL",
  );
  expect(live.rows).toEqual([]);
  // …and it was RETRACTED, not destroyed: with no memory tables in v3 there was
  // nothing to attribute this page to, and an unattributable page under memory/
  // may be a note the user wrote themselves. Its bytes survive; no read returns
  // them.
  const kept = await db.query(
    "SELECT body, deleted_at FROM pages WHERE slug = 'memory/scoped/mem-legacy-1'",
  );
  expect(kept.rows.length).toBe(1);
  expect(kept.rows[0].deleted_at).not.toBeNull();
  expect(String(kept.rows[0].body)).toContain("finance@example.com");
  // The user's own pages are untouched, and the retract dropped the chunks it
  // should (there were none to drop here, but a live page's must survive).
  expect(
    Number(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug NOT LIKE 'memory/%'",
        )
      ).rows[0].n,
    ),
  ).toBe(2);
  await pg.close();
});

// The v5 scope collapse against the shape that made scopes worth having: the
// SAME key live in two of them. `memory_items_active_key` is unique over
// (scope_type, coalesce(scope_id,''), memory_type, memory_key) for committed
// keyed rows, so collapsing those rows collides — and the failure is not a
// skipped migration. migrate() throws, initSchema throws, schema_version stays
// 4, and every subsequent open fails identically: the brain never opens again
// and cannot repair itself. One `user.billing_email` per thread is the ordinary
// case, so this is what an upgrade of a used brain actually looks like.
test("v5 collapses a key that was live in two scopes without bricking the brain", async () => {
  const lite = await PGlite.create({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(lite);
  const meta = { embeddingModel: "m", embeddingDim: DIM };
  await initSchema(db, meta);

  const seed = async (scope: string, id: string | null, content: string, ago: string) =>
    db.query(
      `INSERT INTO memory_items
         (id, scope_type, scope_id, memory_type, memory_key, content, status, fingerprint,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'semantic', 'user.billing_email', $3, 'committed',
               md5($3), now() - $4::interval, now() - $4::interval)`,
      [scope, id, content, ago],
    );
  await seed("thread", "t-a", "older@example.com", "2 days");
  await seed("thread", "t-b", "newest@example.com", "0 days");
  await seed("vault", null, "vault@example.com", "1 day");

  // Re-run the ladder from before the collapse, exactly as an upgrade does.
  await db.query("UPDATE meta SET schema_version = 4 WHERE id = 1");
  await initSchema(db, meta);

  const rows = (
    await db.query(
      "SELECT status, scope_type, scope_id, content FROM memory_items ORDER BY content",
    )
  ).rows as { status: string; scope_type: string; scope_id: string | null; content: string }[];

  // Nothing is destroyed, everything is in the one scope, and exactly one row
  // per key is live — newest wins.
  expect(rows).toHaveLength(3);
  for (const r of rows) {
    expect(r.scope_type).toBe("vault");
    expect(r.scope_id).toBeNull();
  }
  const live = rows.filter((r) => r.status === "committed");
  expect(live.map((r) => r.content)).toEqual(["newest@example.com"]);
  // Superseded, not deleted: the same verb a correction uses, so history stays
  // readable through inspect_memory and `as_of` instead of dying in an upgrade.
  expect(rows.filter((r) => r.status === "superseded")).toHaveLength(2);

  // And the brain OPENS afterwards, which is the property the collision broke.
  const after = (await db.query("SELECT schema_version FROM meta")).rows[0] as {
    schema_version: number;
  };
  expect(Number(after.schema_version)).toBe(5);
  await lite.close();
});
