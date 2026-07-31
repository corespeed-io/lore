// The retrieval regression gate.
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT. The embeddings here are a
// deterministic char-hash, so the vector arm carries no meaning: these numbers
// score the LEXICAL arms (full-text + trigram/ILIKE) and the fusion around
// them. That is exactly the part a refactor breaks silently, so it is worth
// gating — but it is NOT a claim about retrieval quality against a real model.
//
// WHY IT EXISTS. Nothing that multiplies, floors, or truncates a score should
// ship before there is a baseline to compare against: no title boost, no
// backlink boost, no similarity floor, no autocut, no reranker. Land a ranking
// change and these numbers move; if they move down, the change is a
// regression, whatever it did for the one query you tried by hand.

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";
import fixture from "./fixtures/retrieval.json" with { type: "json" };
import { ndcgAt, precisionAt, recallAt, reciprocalRank } from "./metrics.js";

const DIM = 8;
const K = 10;

const embed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(DIM).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % DIM] += (t.charCodeAt(i) % 97) / 97;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

let pg: PGlite;
let store: Store;

function pgliteDb(lite: PGlite): Db {
  const q: Query = async (text, params) => ({
    rows: (await lite.query(text, params as unknown[])).rows as Record<string, unknown>[],
  });
  return {
    query: q,
    async tx(fn) {
      const out = await lite.transaction((t) =>
        fn(async (text, params) => ({
          rows: (await t.query(text, params as unknown[])).rows as Record<string, unknown>[],
        })),
      );
      return out as Awaited<ReturnType<typeof fn>>;
    },
  };
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector, pg_trgm } });
  const db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  store = createStore(db, embed);
  for (const doc of fixture.corpus) {
    await store.putPage({
      slug: doc.slug,
      body: doc.body,
      frontmatter: "aliases" in doc && doc.aliases ? { aliases: doc.aliases } : undefined,
    });
  }
}, 60_000);

afterAll(async () => {
  await pg.close();
});

test("metric functions behave on hand-checked cases", () => {
  expect(recallAt(["a", "b", "c"], ["a", "c"], 3)).toBe(1);
  expect(recallAt(["a", "b", "c"], ["a", "z"], 3)).toBe(0.5);
  expect(recallAt(["x"], ["a"], 3)).toBe(0);
  expect(precisionAt(["a", "z"], ["a"], 2)).toBe(0.5);
  expect(reciprocalRank(["z", "a"], ["a"])).toBe(0.5);
  expect(reciprocalRank(["z"], ["a"])).toBe(0);
  expect(ndcgAt(["a", "b"], ["a"], 2)).toBe(1);
  // a relevant hit in second place scores below one, and above third place
  expect(ndcgAt(["z", "a"], ["a"], 2)).toBeCloseTo(1 / Math.log2(3), 6);
  expect(ndcgAt(["z", "a"], ["a"], 2)).toBeGreaterThan(ndcgAt(["z", "y", "a"], ["a"], 3));
});

test(`retrieval baseline over ${fixture.queries.length} queries`, async () => {
  const rows: { q: string; r: number; p: number; n: number; rr: number; miss: string[] }[] = [];
  for (const { q, relevant } of fixture.queries) {
    const hits = await store.search({ query: q, limit: K });
    const ranked = hits.map((h) => h.slug);
    const found = new Set(ranked.slice(0, K));
    rows.push({
      q,
      r: recallAt(ranked, relevant, K),
      p: precisionAt(ranked, relevant, K),
      n: ndcgAt(ranked, relevant, K),
      rr: reciprocalRank(ranked, relevant),
      miss: relevant.filter((s) => !found.has(s)),
    });
  }
  const mean = (pick: (r: (typeof rows)[number]) => number) =>
    rows.reduce((s, r) => s + pick(r), 0) / rows.length;
  const report = {
    queries: rows.length,
    [`recall@${K}`]: +mean((r) => r.r).toFixed(4),
    [`ndcg@${K}`]: +mean((r) => r.n).toFixed(4),
    mrr: +mean((r) => r.rr).toFixed(4),
    [`precision@${K}`]: +mean((r) => r.p).toFixed(4),
  };
  // Printed on every run so a diff in CI output is the signal, not just a pass.
  console.log("retrieval baseline:", JSON.stringify(report));
  const misses = rows.filter((r) => r.miss.length);
  if (misses.length) {
    console.log("misses:", JSON.stringify(misses.map((m) => ({ q: m.q, miss: m.miss }))));
  }

  // BASELINE recorded 2026-07-31 against the lexical arms:
  //   recall@10 0.9417 · ndcg@10 0.9291 · mrr 0.9667 · precision@10 0.105
  // Floors sit just under those, with a little room for RRF tie order. Raise
  // them when a change genuinely improves retrieval; never lower them to make
  // a build pass — that is the one move this file exists to prevent.
  expect(report[`recall@${K}`]).toBeGreaterThanOrEqual(0.9);
  expect(report[`ndcg@${K}`]).toBeGreaterThanOrEqual(0.85);
  expect(report.mrr).toBeGreaterThanOrEqual(0.85);
}, 60_000);

test("every query returns something, and nothing returns the whole corpus", async () => {
  for (const { q } of fixture.queries) {
    const hits = await store.search({ query: q, limit: K });
    expect(hits.length, `"${q}" returned nothing`).toBeGreaterThan(0);
    expect(hits.length, `"${q}" returned everything`).toBeLessThanOrEqual(K);
  }
});
