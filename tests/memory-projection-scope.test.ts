// What the page projection may and may not carry about a memory's SCOPE.
//
// The page graph has no principal: /api/mcp authenticates one shared
// BRAIN_READ_TOKEN for every agent and every thread, so every page read is an
// UNSCOPED read. The memory tools go to real lengths to keep one caller from
// learning that another scope's memory exists (recall/forget/inspect_memory all
// require the scope and report an out-of-scope hit as not_found); the page tools
// walk around all of it.
//
// This file pins the two halves of the answer:
//   1. No page read attributes a memory to its scope HOLDER — not through the
//      slug, not through the body, not through the frontmatter. That is pure leak:
//      recall filters scope on memory_items and never consults the page for it.
//   2. Every non-shared projection is identifiable from the SLUG ALONE, so the
//      remaining half — a page tool must not return one — is one predicate applied
//      at mcp.ts's tools/call dispatcher, not a filter re-added at eight call
//      sites. The test simulates that filter and shows it is complete.
//
// Plus the repair arm: a retracted page that comes back to life is re-retracted,
// so stale_active_projections really does reach 0 after a maintenance pass.

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import { memoryHealth } from "../src/server/memory/consolidate.js";
import { appendConversationEvent, ensureThread } from "../src/server/memory/events.js";
import { deterministicExtractor, runExtraction } from "../src/server/memory/extract.js";
import { revokeMemory, writeMemory } from "../src/server/memory/items.js";
import {
  isScopedProjection,
  projectMemory,
  projectionSlug,
  runProjections,
} from "../src/server/memory/projection.js";
import { recallMemory } from "../src/server/memory/recall.js";
import type { EmbedFn } from "../src/server/pipeline.js";
import { type Store, createStore } from "../src/server/store.js";

const DIM = 8;
const embed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(DIM).fill(0.01);
    for (let i = 0; i < t.length; i++) v[i % DIM] += (t.charCodeAt(i) % 97) / 97;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

let pg: PGlite;
let db: Db;
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
  db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  store = createStore(db, embed);
}, 120_000);

afterAll(async () => {
  await pg.close();
});

// Every read on the page surface that takes no scope argument — which is all of
// them. Collected in one place so a new page tool has an obvious home here.
async function pageSurface(slug: string): Promise<unknown[]> {
  const reads: unknown[] = [
    await store.search({ query: "billing" }),
    await store.search({ query: "finance@example.com" }),
    await store.listPages({ kind: "memory" }),
    await store.listPages({}),
    await store.recentPages({}),
    await store.findOrphans({}),
    await store.getBacklinks({ slug }),
    await store.traverseGraph({ slug }),
    await store.exportBatch({}),
  ];
  try {
    reads.push(await store.getPage({ slug }));
  } catch (e) {
    reads.push(String(e));
  }
  return reads;
}

test("the refutation: no page read attributes a scoped memory to its thread", async () => {
  // Verbatim from the refutation: the memory row is right, and every page read is
  // the way around it.
  await ensureThread(db, "tA");
  await appendConversationEvent(db, {
    threadId: "tA",
    eventType: "user_message",
    content: "My billing email is finance@example.com.",
  });
  await runExtraction(db, deterministicExtractor, {
    threadId: "tA",
    allowedScopes: [{ scopeType: "thread", scopeId: "tA" }],
  });
  const projected = await runProjections(db, store, 50);
  expect(projected.projected).toBe(1);
  const slug = String(projected.results[0].slug);

  // The row is still exactly what the scope fix made it.
  const row = await db.query(
    "SELECT id, scope_type, scope_id FROM memory_items WHERE status = 'committed'",
  );
  expect(row.rows.map((r) => [r.scope_type, r.scope_id])).toEqual([["thread", "tA"]]);

  // The page is marked as not-shared, in the one field every read returns…
  expect(slug).toBe(`memory/scoped/${row.rows[0].id}`);
  expect(isScopedProjection(slug)).toBe(true);
  // …and carries no owner: not in the slug, not in the body, not in the
  // frontmatter. "tA" is the thread id from the scenario; "/ta/" is the folded
  // form the slug used to carry it in.
  const dump = JSON.stringify(await pageSurface(slug));
  expect(dump).not.toContain("tA");
  expect(dump).not.toContain("/ta/");
  const page = (await store.getPage({ slug })) as {
    body: string;
    frontmatter: Record<string, unknown>;
  };
  expect(page.frontmatter.scope_id).toBeUndefined();
  expect(page.body).toContain("- scope: thread");
  expect(page.body).not.toContain("(tA)");

  // And the memory is still recallable BY ITS OWN THREAD and by nobody else —
  // removing the attribution must not have touched the boundary that works.
  const own = await recallMemory(db, store, {
    query: "billing email",
    scopes: [{ scopeType: "thread", scopeId: "tA" }],
    limit: 8,
  });
  expect(own.map((r) => r.memory.content)).toEqual(["billing email is finance@example.com"]);
  const other = await recallMemory(db, store, {
    query: "billing email",
    scopes: [{ scopeType: "thread", scopeId: "tB" }],
    limit: 8,
  });
  expect(other.length).toBe(0);
});

test("one slug predicate closes the shared read surface, and it is complete", async () => {
  // One memory per scope, so the predicate is exercised on both sides.
  const ev = await appendConversationEvent(db, {
    threadId: "tA",
    eventType: "user_message",
    content: "The vault convention is one folder per project.",
  });
  const vault = await writeMemory(db, {
    scopeType: "vault",
    memoryType: "semantic",
    memoryKey: "vault.convention",
    content: "vault convention is one folder per project",
    sourceEventIds: [ev.event.id],
    explicit: true,
  });
  const agent = await writeMemory(db, {
    scopeType: "agent",
    scopeId: "agent-7",
    memoryType: "preference",
    memoryKey: "user.response_style",
    content: "Prefers concise technical answers",
    sourceEventIds: [ev.event.id],
    explicit: true,
  });
  await runProjections(db, store, 50);

  // The mark is derived from the scope for EVERY projection, with no third state:
  // a scoped memory cannot end up behind a shared-looking slug.
  const memories = await db.query(
    "SELECT id, scope_type FROM memory_items WHERE status = 'committed'",
  );
  for (const m of memories.rows) {
    const slug = projectionSlug({
      id: String(m.id),
      scope_type: m.scope_type,
    } as Parameters<typeof projectionSlug>[0]);
    expect(isScopedProjection(slug)).toBe(m.scope_type !== "vault");
    const live = await db.query(
      "SELECT 1 FROM pages WHERE slug = $1 AND deleted_at IS NULL AND kind = 'memory'",
      [slug],
    );
    expect(live.rows.length).toBe(1);
  }

  // Simulate the dispatcher filter: drop every hit whose slug is a scoped
  // projection. What survives is the vault memory and the caller's own notes —
  // and nothing carries a scoped memory's value any more.
  const filtered = (hits: { slug: string }[]) => hits.filter((h) => !isScopedProjection(h.slug));
  const shared = [
    ...filtered(await store.search({ query: "billing" })),
    ...filtered(await store.search({ query: "finance@example.com" })),
    ...filtered(await store.search({ query: "concise technical answers" })),
    ...filtered(await store.listPages({ kind: "memory" })),
    ...filtered(await store.recentPages({})),
    ...filtered(await store.findOrphans({})),
    // /api/export is the second door and does NOT go through the tool dispatcher;
    // the same predicate covers it, which is the point of putting the mark in the
    // slug rather than in a column only the store can see.
    ...filtered(await store.exportBatch({})),
  ];
  const sharedDump = JSON.stringify(shared);
  expect(sharedDump).not.toContain("finance@example.com");
  expect(sharedDump).not.toContain("Prefers concise technical answers");
  // The vault memory is still there: the filter removes scope, not memory.
  expect(sharedDump).toContain("vault convention is one folder per project");
  expect(shared.some((h) => h.slug === `memory/vault/${vault.memory?.id}`)).toBe(true);
  // Nothing that survives the filter is a scoped projection.
  expect(shared.filter((h) => isScopedProjection(h.slug))).toEqual([]);
  // And the agent memory is still recallable in its own scope.
  expect(
    (
      await recallMemory(db, store, {
        query: "concise technical answers",
        scopes: [{ scopeType: "agent", scopeId: "agent-7" }],
        limit: 8,
      })
    ).map((r) => r.memory.id),
  ).toEqual([agent.memory?.id]);
});

test("a retracted page brought back to life is re-retracted, and the sweep converges", async () => {
  const ev = await appendConversationEvent(db, {
    threadId: "tA",
    eventType: "user_message",
    content: "My deploy host is deploy.example.com.",
  });
  const written = await writeMemory(db, {
    scopeType: "thread",
    scopeId: "tA",
    memoryType: "semantic",
    memoryKey: "user.deploy_host",
    content: "deploy host is deploy.example.com",
    sourceEventIds: [ev.event.id],
    explicit: true,
  });
  const memory = written.memory;
  if (!memory) throw new Error("memory was not committed");
  expect((await projectMemory(db, store, memory)).status).toBe("ok");
  const slug = projectionSlug(memory);

  // forget: the page is retracted and the bookkeeping says so.
  const revoked = await revokeMemory(db, { memoryId: memory.id, actor: "test" });
  if (!revoked) throw new Error("revoke failed");
  expect((await projectMemory(db, store, revoked)).status).toBe("removed");
  expect(await memoryHealth(db).then((h) => h.stale_active_projections)).toBe(0);

  // The page comes back to life. The in-app write paths are closed at the store
  // now (reservedAndUnowned), so this arrives from OUTSIDE the app: a hand-repair
  // in psql, a partial restore from a backup, or a release whose restore_page /
  // rename_page guards were missing — AGENTS.md records those shipping missing
  // twice. Postgres is canonical and a page is a derived artifact, so the sweep
  // has to repair state it did not create; a guard on the write path cannot.
  await db.query("UPDATE pages SET deleted_at = NULL WHERE slug = $1", [slug]);
  const before = await memoryHealth(db);
  expect(before.stale_active_projections).toBe(1);
  const revokedPage = await store.getPage({ slug });
  expect(JSON.stringify(revokedPage)).toContain("deploy.example.com");

  // One maintenance pass, and the promise in AGENTS.md holds.
  const swept = await runProjections(db, store, 50);
  expect(swept.results.find((r) => r.memoryId === memory.id)?.status).toBe("removed");
  expect(await memoryHealth(db).then((h) => h.stale_active_projections)).toBe(0);
  await expect(store.getPage({ slug })).rejects.toThrow(/not_found/);

  // Converged, not oscillating: the next pass has nothing to do for this memory.
  const again = await runProjections(db, store, 50);
  expect(again.results.map((r) => r.memoryId)).not.toContain(memory.id);
});

test("the mirror arm still holds: a deleted page of a committed memory is rebuilt", async () => {
  // The retract arm above and this build arm are now ONE predicate, so this is the
  // regression guard for rewriting it: delete_page on a live projection is allowed
  // (a page is a derived artifact — a cache eviction, not a revocation) and the
  // next pass must bring it back, or the memory is silently unsearchable.
  const ev = await appendConversationEvent(db, {
    threadId: "tA",
    eventType: "user_message",
    content: "Remember that the cortado is the afternoon pour.",
  });
  const written = await writeMemory(db, {
    scopeType: "vault",
    memoryType: "semantic",
    content: "the cortado is the afternoon pour",
    sourceEventIds: [ev.event.id],
    explicit: true,
  });
  const memory = written.memory;
  if (!memory) throw new Error("memory was not committed");
  const slug = projectionSlug(memory);
  expect((await projectMemory(db, store, memory)).status).toBe("ok");

  await store.deletePage({ slug });
  await expect(store.getPage({ slug })).rejects.toThrow(/not_found/);

  const swept = await runProjections(db, store, 50);
  expect(swept.results.find((r) => r.memoryId === memory.id)?.status).toBe("ok");
  expect(String((await store.getPage({ slug })).body)).toContain("afternoon pour");
  const health = await memoryHealth(db);
  expect([health.failed_projections, health.stale_active_projections]).toEqual([0, 0]);
});
