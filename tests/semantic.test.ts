import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import { runSemanticSweep } from "../src/server/semantic.js";

const DIM = 8;

function pgliteDb(lite: PGlite): Db {
  const q: Query = async (text, params) => {
    const res = await lite.query(text, params as unknown[]);
    return { rows: res.rows as Record<string, unknown>[] };
  };
  return {
    query: q,
    async tx(fn) {
      return (await lite.transaction((t) =>
        fn(async (text, params) => {
          const res = await t.query(text, params as unknown[]);
          return { rows: res.rows as Record<string, unknown>[] };
        }),
      )) as never;
    },
  };
}

// A vector pointing mostly along one axis, so pages sharing an axis are near.
const vec = (axis: number, jitter = 0) =>
  JSON.stringify(Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0) + jitter * (i + 1)));

async function seed(db: Db, rows: { slug: string; axis: number; jitter?: number }[]) {
  for (const r of rows) {
    const p = await db.query(
      "INSERT INTO pages (slug, kind, title, body, frontmatter, content_hash) VALUES ($1,'note',$1,'b','{}'::jsonb,$1) RETURNING id",
      [r.slug],
    );
    await db.query(
      "INSERT INTO chunks (page_id, seq, text, context, source, embedding) VALUES ($1,0,'t','','prose',$2::vector)",
      [Number(p.rows[0].id), vec(r.axis, r.jitter ?? 0)],
    );
  }
}

async function fresh() {
  const lite = await PGlite.create({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(lite);
  await initSchema(db, { embeddingModel: "m", embeddingDim: DIM });
  return { db, lite };
}

// THE bug this file exists for: the sweep ran, reported "scanned 100", and did
// not advance — fifteen consecutive batches re-swept the same hundred pages
// while 781 were never reached. The marker was written only for pages with NO
// candidates, so a page whose candidates all failed the mutual-kNN test stayed
// in the todo set forever. "It ran" is not "it progressed".
test("every swept page is marked, so repeated calls walk the whole brain", async () => {
  const { db, lite } = await fresh();
  // Five pages on distinct axes: candidates exist (nothing is orthogonal-far
  // enough to be filtered by the floor alone) but few survive mutual kNN.
  await seed(
    db,
    [0, 1, 2, 3, 4].map((a, i) => ({ slug: `p${i}`, axis: a, jitter: 0.3 })),
  );

  const first = await runSemanticSweep(db, { limit: 2 });
  expect(first.scanned).toBe(2);
  const second = await runSemanticSweep(db, { limit: 2 });
  expect(second.scanned).toBe(2);
  // The third call must reach the LAST page — it cannot if the first two calls
  // re-selected their own pages.
  const third = await runSemanticSweep(db, { limit: 2 });
  expect(third.scanned).toBe(1);
  const fourth = await runSemanticSweep(db, { limit: 2 });
  expect(fourth.scanned).toBe(0);
  await lite.close();
});

test("edgesAdded counts what was actually inserted, not zero", async () => {
  const { db, lite } = await fresh();
  // Two pages on the same axis — near each other, and mutually each other's top
  // neighbour, so exactly one undirected edge must be written and counted.
  await seed(db, [
    { slug: "a", axis: 0 },
    { slug: "b", axis: 0, jitter: 0.01 },
  ]);
  const r = await runSemanticSweep(db, { limit: 10 });
  // ON CONFLICT DO NOTHING returns no rows, so without RETURNING this reported
  // 0 while writing 418 edges — a counter that always says zero is not a counter.
  expect(r.edgesAdded).toBeGreaterThan(0);
  const edges = await db.query(
    "SELECT count(*)::int AS n FROM edges WHERE lane='auto' AND kind='semantic' AND from_page_id <> to_page_id",
  );
  expect(Number(edges.rows[0].n)).toBe(r.edgesAdded);
  await lite.close();
});

test("a dry run writes nothing at all — no edges, no markers", async () => {
  const { db, lite } = await fresh();
  await seed(db, [
    { slug: "a", axis: 0 },
    { slug: "b", axis: 0, jitter: 0.01 },
  ]);
  const r = await runSemanticSweep(db, { limit: 10, dryRun: true });
  expect(r.pairs.length).toBeGreaterThan(0);
  const edges = await db.query("SELECT count(*)::int AS n FROM edges");
  expect(Number(edges.rows[0].n)).toBe(0);
  // And because nothing was marked, the same pages are still pending.
  const again = await runSemanticSweep(db, { limit: 10, dryRun: true });
  expect(again.scanned).toBe(r.scanned);
  await lite.close();
});

// The floor and mutual-kNN are the two rules that keep this from linking
// everything to everything; a hub page must not collect an edge from every page.
test("an unrelated page gets no semantic edge", async () => {
  const { db, lite } = await fresh();
  await seed(db, [
    { slug: "near-1", axis: 0 },
    { slug: "near-2", axis: 0, jitter: 0.01 },
    { slug: "far", axis: 7 },
  ]);
  await runSemanticSweep(db, { limit: 10, floor: 0.9 });
  const far = await db.query(
    `SELECT count(*)::int AS n FROM edges e JOIN pages p ON p.id = e.from_page_id OR p.id = e.to_page_id
     WHERE p.slug = 'far' AND e.from_page_id <> e.to_page_id`,
  );
  expect(Number(far.rows[0].n)).toBe(0);
  await lite.close();
});

// The reviewer's round-1 P1, pinned from the threat side. The first marker
// design wrote INSERT (from,to)=(id,id) into the shared edges table, and every
// edge reader believed it: after ONE sweep over pages with nothing to link,
// find_orphans answered [] forever, get_backlinks listed each page as its own
// backlink, traverse_graph returned self-loops. The readers were never wrong —
// the data was poisoned. So the pin is on the data: a real (non-dry) sweep
// that links NOTHING must leave the edges table EMPTY, while still making
// progress. The old code fails this with one row per page swept.
test("a sweep that links nothing writes NO edge rows at all — progress lives outside the graph", async () => {
  const { db, lite } = await fresh();
  await seed(db, [
    { slug: "alpha", axis: 0 },
    { slug: "beta", axis: 3 },
    { slug: "gamma", axis: 6 },
  ]);
  // floor 1.1: cosine similarity cannot reach it, so no real edge is possible.
  const r = await runSemanticSweep(db, { limit: 10, floor: 1.1 });
  expect(r.scanned).toBe(3);
  expect(r.edgesAdded).toBe(0);
  const edges = await db.query("SELECT count(*)::int AS n FROM edges");
  expect(Number(edges.rows[0].n)).toBe(0); // not even a marker
  // ...and the sweep still advanced: nothing is re-selected next call.
  const again = await runSemanticSweep(db, { limit: 10, floor: 1.1 });
  expect(again.scanned).toBe(0);
  await lite.close();
});

// The v7 migration must clean a brain the old marker already poisoned:
// self-edges deleted, REAL semantic edges kept, and the marker-holders'
// progress backfilled into the column so a half-swept brain does not restart.
test("v7 deletes the poisonous self-edge markers, keeps real edges, and keeps progress", async () => {
  const { db, lite } = await fresh();
  await seed(db, [
    { slug: "swept", axis: 0 },
    { slug: "other", axis: 1 },
  ]);
  const id = async (slug: string) =>
    Number((await db.query("SELECT id FROM pages WHERE slug=$1", [slug])).rows[0].id);
  const swept = await id("swept");
  const other = await id("other");
  // Recreate the v6 state by hand: a self-edge marker, a real edge, no column
  // progress, and a meta row claiming v6 so initSchema runs the migration.
  await db.query(
    "INSERT INTO edges (from_page_id, to_page_id, lane, kind) VALUES ($1,$1,'auto','semantic'), ($1,$2,'auto','semantic')",
    [swept, other],
  );
  await db.query("UPDATE pages SET semantic_swept_at = NULL");
  await db.query("UPDATE meta SET schema_version = 6");
  await initSchema(db, { embeddingModel: "m", embeddingDim: DIM });

  const self = await db.query(
    "SELECT count(*)::int AS n FROM edges WHERE from_page_id = to_page_id",
  );
  expect(Number(self.rows[0].n)).toBe(0); // poison gone
  const real = await db.query(
    "SELECT count(*)::int AS n FROM edges WHERE from_page_id <> to_page_id",
  );
  expect(Number(real.rows[0].n)).toBe(1); // inference kept
  const marked = await db.query(
    "SELECT semantic_swept_at IS NOT NULL AS m FROM pages WHERE id = $1",
    [swept],
  );
  expect(marked.rows[0].m).toBe(true); // progress backfilled from the marker
  const version = await db.query("SELECT schema_version FROM meta");
  expect(Number(version.rows[0].schema_version)).toBe(7);
  await lite.close();
});
