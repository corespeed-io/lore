// The one rule this file exists to pin:
//
//   A page under memory/ exists IF AND ONLY IF a committed, VAULT-scoped memory
//   owns that exact address.
//
// Round 2 tried the other shape — project every memory into the shared page graph
// and hide the private ones at the reader — and it was refuted six ways in one
// pass (a fuzzy-title oracle over the hidden content, a permanent DoS, score
// arithmetic, page_count arithmetic, no migration, and the memory tools which
// carry no slug to filter on). All six were consequences of one decision: private
// content in a shared space. So the content is not there any more, and these
// tests check that from BOTH ends — no thread/agent memory is ever written to the
// graph, and nothing left in the graph by an older release survives a sweep.
//
// pages/edges/FTS carry no principal: /api/mcp authenticates one shared
// BRAIN_READ_TOKEN for every agent and every thread, so every page read is an
// UNSCOPED read. `vault` is the only memory scope that means "every reader".

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import { appendConversationEvent, ensureThread } from "../src/server/memory/events.js";
import { deterministicExtractor, runExtraction } from "../src/server/memory/extract.js";
import { type MemoryItem, revokeMemory, writeMemory } from "../src/server/memory/items.js";
import {
  isScopedProjection,
  projectMemory,
  projectionSlug,
  renderProjection,
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
    await store.search({ query: "concise technical answers" }),
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

// What a PRE-MIGRATION database looks like: the page an older release wrote for a
// non-vault memory, under that release's slug shape, with the bookkeeping saying
// everything is fine. Written with raw SQL because the current store refuses the
// address outright — which is the point, and is why the repair cannot be a write
// guard.
async function legacyProjection(
  memory: MemoryItem,
  slug: string,
  // Whether the memory row still points at the page. `false` is the state a
  // projection that died between the put and its UPDATE leaves behind, and it is
  // the one no memory-driven query can see.
  link = true,
): Promise<number> {
  const { body } = renderProjection(memory);
  const res = await db.query(
    `INSERT INTO pages (slug, kind, title, body, frontmatter, content_hash)
     VALUES ($1, 'memory', $2, $3, $4::jsonb, 'legacy') RETURNING id`,
    [
      slug,
      body.split("\n")[0].replace(/^#\s*/, ""),
      body,
      JSON.stringify({
        memory_id: memory.id,
        scope_type: memory.scope_type,
        scope_id: memory.scope_id,
      }),
    ],
  );
  const pageId = Number(res.rows[0].id);
  await db.query(
    `UPDATE memory_items
     SET projection_page_id = $2, projection_status = $3 WHERE id = $1`,
    [memory.id, link ? pageId : null, link ? "ok" : "removed"],
  );
  return pageId;
}

// The invariant, as one query. Returns every violation in EITHER direction, so a
// hole cannot hide behind a passing count.
async function namespaceViolations(): Promise<string[]> {
  const res = await db.query(
    `SELECT p.slug AS what, 'live page with no committed vault owner' AS why
       FROM pages p
      WHERE p.deleted_at IS NULL AND p.slug LIKE 'memory/%'
        AND NOT EXISTS (
          SELECT 1 FROM memory_items m
           WHERE m.status = 'committed' AND m.scope_type = 'vault'
             AND p.slug = 'memory/vault/' || m.id)
     UNION ALL
     SELECT m.id, 'committed vault memory with no live page'
       FROM memory_items m
      WHERE m.status = 'committed' AND m.scope_type = 'vault'
        AND NOT EXISTS (
          SELECT 1 FROM pages p
           WHERE p.deleted_at IS NULL AND p.slug = 'memory/vault/' || m.id)
     UNION ALL
     SELECT m.id, 'non-vault memory still holding a page row'
       FROM memory_items m JOIN pages p ON p.id = m.projection_page_id
      WHERE m.scope_type <> 'vault'`,
    [],
  );
  return res.rows.map((r) => `${r.what}: ${r.why}`);
}

async function memoryRow(key: string): Promise<MemoryItem> {
  const res = await db.query("SELECT * FROM memory_items WHERE memory_key = $1", [key]);
  if (!res.rows.length) throw new Error(`no memory for key ${key}`);
  return res.rows[0] as unknown as MemoryItem;
}

test("the refutation: a thread memory is never written to the shared graph at all", async () => {
  // Verbatim from the refutation that started this: the memory row is right, and
  // every page read is the way around it. There is now no page to go around.
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
  expect(projected.projected).toBe(0);
  expect(projected.results.map((r) => r.status)).toEqual(["removed"]);
  expect(projected.results[0].slug).toBeNull();

  // The row is still exactly what the scope fix made it.
  const row = await db.query(
    "SELECT id, scope_type, scope_id FROM memory_items WHERE status = 'committed'",
  );
  expect(row.rows.map((r) => [r.scope_type, r.scope_id])).toEqual([["thread", "tA"]]);

  // Nothing in the reserved namespace — not live, not soft-deleted, not anywhere.
  const anyPage = await db.query("SELECT slug, deleted_at FROM pages WHERE slug LIKE 'memory/%'");
  expect(anyPage.rows).toEqual([]);
  // And the private value is nowhere in the pages table at all, which is a
  // stronger claim than "no read returns it": there is no row to forget a
  // `deleted_at IS NULL` on.
  const anyBody = await db.query("SELECT count(*)::int AS n FROM pages WHERE body LIKE $1", [
    "%finance@example.com%",
  ]);
  expect(Number(anyBody.rows[0].n)).toBe(0);

  const dump = JSON.stringify(await pageSurface(`memory/scoped/${row.rows[0].id}`));
  expect(dump).not.toContain("finance@example.com");
  expect(dump).not.toContain("tA");

  // And the memory is still recallable BY ITS OWN THREAD and by nobody else. This
  // is the canonical arm: there is no projection behind it.
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

test("vault memories still get their page, and every write door into the namespace is shut", async () => {
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

  const vaultId = vault.memory?.id ?? "";
  const agentId = agent.memory?.id ?? "";
  expect(projectionSlug(vault.memory as MemoryItem)).toBe(`memory/vault/${vaultId}`);
  // The chokepoint: a non-shared memory has no address, so there is nowhere for a
  // page to be written and nothing for a reader to be filtered out of.
  expect(projectionSlug(agent.memory as MemoryItem)).toBeNull();

  const live = await db.query(
    "SELECT slug FROM pages WHERE slug LIKE 'memory/%' AND deleted_at IS NULL ORDER BY slug",
  );
  expect(live.rows.map((r) => r.slug)).toEqual([`memory/vault/${vaultId}`]);

  // store.putPage asks projectionSlug who owns an address, so narrowing that one
  // function shut every write door at once: nothing can create a page for the
  // agent memory, at any slug shape, with any body.
  const { body } = renderProjection(agent.memory as MemoryItem);
  for (const slug of [
    `memory/scoped/${agentId}`,
    `memory/vault/${agentId}`,
    `memory/agent/agent-7/${agentId}`,
  ]) {
    await expect(store.putPage({ slug, body })).rejects.toThrow(/reserved/);
    await expect(store.putPage({ slug, body: "harmless" })).rejects.toThrow(/reserved/);
    await expect(store.restorePage({ slug })).rejects.toThrow();
  }
  // Renaming a note INTO the namespace is refused too, so the door cannot be
  // walked around by creating the page somewhere legal first.
  await store.putPage({ slug: "notes/decoy", body: "decoy" });
  await expect(
    store.renamePage({ slug: "notes/decoy", to: `memory/vault/${agentId}` }),
  ).rejects.toThrow(/reserved/);

  // Nothing on the shared surface carries the agent memory, and the vault one is
  // still there: the design removes scope, not memory.
  const dump = JSON.stringify(await pageSurface(`memory/vault/${vaultId}`));
  expect(dump).not.toContain("Prefers concise technical answers");
  expect(dump).toContain("vault convention is one folder per project");

  // The agent memory is still recallable in its own scope, through the canonical
  // arm, and page search cannot reach it.
  expect(
    (
      await recallMemory(db, store, {
        query: "concise technical answers",
        scopes: [{ scopeType: "agent", scopeId: "agent-7" }],
        limit: 8,
      })
    ).map((r) => r.memory.id),
  ).toEqual([agentId]);
  expect(
    (await store.search({ query: "concise technical answers" })).map((h) => h.slug),
  ).not.toContain(`memory/scoped/${agentId}`);
  expect(await namespaceViolations()).toEqual([]);
});

test("MIGRATION: every projection an older release wrote for a non-vault memory is removed", async () => {
  // The adversary's finding, verbatim: "runProjections' due-predicate does not
  // select a committed memory with projection_status='ok' and a live page, so the
  // sweep returned []". Both historical slug shapes are reproduced, because a
  // migration that only knows the newest one is not a migration.
  const thread = await memoryRow("user.billing_email");
  const agent = await memoryRow("user.response_style");
  const legacyThread = await legacyProjection(thread, `memory/thread/ta/${thread.id}`);
  const legacyAgent = await legacyProjection(agent, `memory/scoped/${agent.id}`);

  // …and the case a memory-driven sweep is BLIND to: the same leak with the link
  // gone and the bookkeeping already claiming 'removed'. No arm of any query over
  // memory_items can reach this page — its memory row says there is nothing to do
  // — so it is only repairable by enumerating the pages themselves.
  const ev = await appendConversationEvent(db, {
    threadId: "tA",
    eventType: "user_message",
    content: "My pager number is 555-0199.",
  });
  const orphaned = await writeMemory(db, {
    scopeType: "thread",
    scopeId: "tA",
    memoryType: "semantic",
    memoryKey: "user.pager",
    content: "pager number is 555-0199",
    sourceEventIds: [ev.event.id],
    explicit: true,
  });
  const orphanMemory = orphaned.memory;
  if (!orphanMemory) throw new Error("memory was not committed");
  const legacyOrphan = await legacyProjection(
    orphanMemory,
    `memory/thread/ta/${orphanMemory.id}`,
    false,
  );

  // Pre-migration, this is a real leak on the shared surface: all three findable.
  const leaked = JSON.stringify([
    await store.search({ query: "billing email" }),
    await store.search({ query: "concise technical answers" }),
    await store.search({ query: "pager number" }),
    await store.listPages({ kind: "memory" }),
  ]);
  expect(leaked).toContain("finance@example.com");
  expect(leaked).toContain("Prefers concise technical answers");
  expect(leaked).toContain("555-0199");

  const swept = await runProjections(db, store, 50);

  // Gone as ROWS, not merely hidden: a soft delete would leave the private value
  // in pages.body behind a `deleted_at IS NULL` that every read has to remember.
  // Asserted before the counters, so a regression is reported as the leak it is
  // rather than as an unexpected number.
  const rows = await db.query("SELECT count(*)::int AS n FROM pages WHERE id = ANY($1::bigint[])", [
    [legacyThread, legacyAgent, legacyOrphan],
  ]);
  expect(Number(rows.rows[0].n)).toBe(0);
  expect([swept.namespace.purged, swept.namespace.failed]).toEqual([3, 0]);
  const bodies = await db.query(
    "SELECT count(*)::int AS n FROM pages WHERE body LIKE $1 OR body LIKE $2 OR body LIKE $3",
    ["%finance@example.com%", "%Prefers concise technical answers%", "%555-0199%"],
  );
  expect(Number(bodies.rows[0].n)).toBe(0);

  // The bookkeeping converges in the SAME pass: purging the page clears
  // projection_page_id, which is what makes the memory due.
  const book = await db.query(
    "SELECT projection_status, projection_page_id FROM memory_items WHERE id = ANY($1::text[])",
    [[thread.id, agent.id]],
  );
  expect(book.rows.map((r) => [r.projection_status, r.projection_page_id])).toEqual([
    ["removed", null],
    ["removed", null],
  ]);
  expect(await namespaceViolations()).toEqual([]);

  // Converged, not oscillating — and "converged" means the due query selects
  // NOTHING, not merely that another pass does no damage. A predicate that keeps
  // re-selecting a memory it can never satisfy is the never-converging repair
  // wearing a passing test.
  const again = await runProjections(db, store, 50);
  expect([again.namespace.purged, again.namespace.retracted, again.projected]).toEqual([0, 0, 0]);
  expect(again.results).toEqual([]);
  // Both memories are still recallable in their own scope — the migration removed
  // the projection, not the memory.
  expect(
    (
      await recallMemory(db, store, {
        query: "billing email",
        scopes: [{ scopeType: "thread", scopeId: "tA" }],
      })
    ).length,
  ).toBe(1);
});

test("a retracted vault page brought back to life is re-retracted, even with its link cut", async () => {
  const ev = await appendConversationEvent(db, {
    threadId: "tA",
    eventType: "user_message",
    content: "Remember: the deploy host is deploy.example.com.",
  });
  const written = await writeMemory(db, {
    scopeType: "vault",
    memoryType: "semantic",
    memoryKey: "vault.deploy_host",
    content: "deploy host is deploy.example.com",
    sourceEventIds: [ev.event.id],
    explicit: true,
  });
  const memory = written.memory;
  if (!memory) throw new Error("memory was not committed");
  expect((await projectMemory(db, store, memory)).status).toBe("ok");
  const slug = projectionSlug(memory);
  if (!slug) throw new Error("a vault memory must have an address");

  // forget: the page is retracted and the bookkeeping says so.
  const revoked = await revokeMemory(db, { memoryId: memory.id, actor: "test" });
  if (!revoked) throw new Error("revoke failed");
  expect((await projectMemory(db, store, revoked)).status).toBe("removed");

  // The page comes back from OUTSIDE the app — a hand-repair in psql, a partial
  // restore from a backup — AND its link is cut, which is the variant that never
  // converged: with projection_page_id gone, no arm of a memory-driven due query
  // can see the page, so the revoked content answered search forever. The sweep
  // now enumerates the PAGES, so a lost link hides nothing.
  await db.query("UPDATE pages SET deleted_at = NULL WHERE slug = $1", [slug]);
  await db.query("UPDATE memory_items SET projection_page_id = NULL WHERE id = $1", [memory.id]);
  expect(JSON.stringify(await store.getPage({ slug }))).toContain("deploy.example.com");
  expect(await namespaceViolations()).not.toEqual([]);

  const swept = await runProjections(db, store, 50);
  await expect(store.getPage({ slug })).rejects.toThrow(/not_found/);
  expect(await namespaceViolations()).toEqual([]);
  expect(swept.namespace.retracted).toBe(1);

  // Converged: the next pass has nothing to do, for the page or for the memory,
  // and the due query selects nothing at all.
  const again = await runProjections(db, store, 50);
  expect([again.namespace.retracted, again.namespace.purged, again.projected]).toEqual([0, 0, 0]);
  expect(again.results).toEqual([]);

  // A vault page is RETRACTED rather than purged, because a re-commit revives it
  // through the same stable address. That is the difference from a scoped page,
  // whose address may never hold a page at all.
  const dead = await db.query("SELECT deleted_at FROM pages WHERE slug = $1", [slug]);
  expect(dead.rows.length).toBe(1);
  expect(dead.rows[0].deleted_at).not.toBeNull();
});

test("the mirror arm still holds: a deleted page of a committed vault memory is rebuilt", async () => {
  // delete_page on a live projection is allowed (a page is a derived artifact — a
  // cache eviction, not a revocation) and the next pass must bring it back, or the
  // memory is silently unsearchable. The regression guard for rewriting the due
  // query, which now judges the ADDRESS rather than the recorded link.
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
  if (!slug) throw new Error("a vault memory must have an address");
  expect((await projectMemory(db, store, memory)).status).toBe("ok");

  await store.deletePage({ slug });
  await expect(store.getPage({ slug })).rejects.toThrow(/not_found/);

  const swept = await runProjections(db, store, 50);
  expect(swept.results.find((r) => r.memoryId === memory.id)?.status).toBe("ok");
  expect(String((await store.getPage({ slug })).body)).toContain("afternoon pour");
  expect(await namespaceViolations()).toEqual([]);
});

test("a page in the reserved namespace that no memory claims is retracted, not destroyed", async () => {
  // A database written before the namespace guard could have a REAL user note
  // here. It must not be readable (no reader can tell it from a projection) and it
  // must not be deleted either — a personal brain does not trade data loss for
  // tidiness. Also covers the squatter case: an unattributable memory/ page.
  await db.query(
    `INSERT INTO pages (slug, kind, title, body, content_hash)
     VALUES ('memory/recipes/sourdough', 'note', 'Sourdough', 'A note the user wrote themselves.', 'legacy')`,
    [],
  );
  const swept = await runProjections(db, store, 50);
  await expect(store.getPage({ slug: "memory/recipes/sourdough" })).rejects.toThrow(/not_found/);
  expect(swept.namespace.retracted).toBe(1);
  const kept = await db.query("SELECT body FROM pages WHERE slug = 'memory/recipes/sourdough'");
  expect(String(kept.rows[0].body)).toContain("the user wrote themselves");
  expect(await namespaceViolations()).toEqual([]);
  // And it stays converged: a retracted unowned page is not re-retracted forever.
  const again = await runProjections(db, store, 50);
  expect(again.namespace.retracted).toBe(0);
});

// --- adjacent paths, attacked on purpose --------------------------------------
//
// None of these were in the brief. Each is a way to reach the same bad state from
// one step to the side, which is how every previous fix in this file was refuted.

test("adjacent: the oracles round 2 left behind have nothing to be an oracle over", async () => {
  // Refutation 1 was a fuzzy-TITLE substring probe: get_page{fuzzy} matches on
  // title, so a caller could confirm a hidden memory's content one substring at a
  // time without ever reading the page. Refutation 4 was page_count arithmetic:
  // the number moved when a hidden page appeared. Both are questions about a page
  // that no longer exists, so both now answer the same as for a memory that was
  // never written.
  const before = await store.pageCount();
  const ev = await appendConversationEvent(db, {
    threadId: "tA",
    eventType: "user_message",
    content: "My safe combination is 31-14-9.",
  });
  const secret = await writeMemory(db, {
    scopeType: "thread",
    scopeId: "tA",
    memoryType: "semantic",
    memoryKey: "user.safe_combination",
    content: "safe combination is 31-14-9",
    sourceEventIds: [ev.event.id],
    explicit: true,
  });
  await runProjections(db, store, 50);
  expect(await store.pageCount()).toBe(before);

  for (const probe of ["safe combination", "31-14", "user.safe_combination", "31-14-9"]) {
    await expect(store.getPage({ slug: probe, fuzzy: true })).rejects.toThrow(/not_found/);
    expect(JSON.stringify(await store.search({ query: probe }))).not.toContain("31-14-9");
  }
  // Still the owner's, though.
  expect(
    (
      await recallMemory(db, store, {
        query: "safe combination",
        scopes: [{ scopeType: "thread", scopeId: "tA" }],
      })
    ).map((r) => r.memory.id),
  ).toEqual([secret.memory?.id]);
});

test("adjacent: a scope flipped underneath a live projection is reconciled, both ways", async () => {
  // Nothing in the app rewrites scope_type — but the invariant is about the state
  // of the database, not about the paths this release happens to have. A vault
  // memory turned private (a data migration, a hand-repair) must lose its page,
  // and the reverse must get one, without anyone teaching the sweep about scope
  // changes: both fall out of asking projectionSlug what the row owns NOW.
  const vault = await memoryRow("vault.convention");
  const slug = `memory/vault/${vault.id}`;
  expect(JSON.stringify(await store.getPage({ slug }))).toContain("one folder per project");

  await db.query(
    "UPDATE memory_items SET scope_type = 'agent', scope_id = 'agent-9' WHERE id = $1",
    [vault.id],
  );
  await runProjections(db, store, 50);
  await expect(store.getPage({ slug })).rejects.toThrow(/not_found/);
  const gone = await db.query("SELECT count(*)::int AS n FROM pages WHERE slug = $1", [slug]);
  expect(Number(gone.rows[0].n)).toBe(0);
  expect(await namespaceViolations()).toEqual([]);
  // Reachable in its new scope, and only there.
  expect(
    (
      await recallMemory(db, store, {
        query: "import convention folder",
        scopes: [{ scopeType: "agent", scopeId: "agent-9" }],
      })
    ).length,
  ).toBe(1);

  await db.query("UPDATE memory_items SET scope_type = 'vault', scope_id = NULL WHERE id = $1", [
    vault.id,
  ]);
  await runProjections(db, store, 50);
  expect(String((await store.getPage({ slug })).body)).toContain("one folder per project");
  expect(await namespaceViolations()).toEqual([]);
});

test("adjacent: a stray whose last segment is NOT a memory id is still taken off every read", async () => {
  // The sweep names a page's owner by its last slug segment. That hint is
  // deliberately over-broad, and this is the shape that DEFEATS it — the id is in
  // the path but not at the end. The fail-safe direction matters: an
  // unattributable page under memory/ is retracted from every read rather than
  // kept because the hint missed.
  const thread = await memoryRow("user.billing_email");
  await db.query(
    `INSERT INTO pages (slug, kind, title, body, content_hash)
     VALUES ($1, 'memory', 'leftover', $2, 'legacy')`,
    [`memory/thread/ta/${thread.id}/leftover`, "leftover copy: finance@example.com"],
  );
  await runProjections(db, store, 50);
  expect(JSON.stringify(await store.search({ query: "finance@example.com" }))).not.toContain(
    "leftover copy",
  );
  expect(await namespaceViolations()).toEqual([]);
  // Retracted, not purged — the hint could not attribute it, so it might be a user
  // page. The row survives; no read returns it.
  const row = await db.query("SELECT deleted_at FROM pages WHERE slug LIKE '%/leftover'");
  expect(row.rows.length).toBe(1);
  expect(row.rows[0].deleted_at).not.toBeNull();
});

test("adjacent: mid-migration, recall's page arm still cannot hand over another scope's memory", async () => {
  // The window between deploying this and the first maintenance pass. The page
  // exists, it is searchable, and recall's candidate generation is store.search —
  // which is exactly how round 2's filter was walked around. The page arm is only
  // ever given SHARED scopes, so a private memory cannot come back through it even
  // while its page is still there.
  const thread = await memoryRow("user.billing_email");
  const legacyPage = await legacyProjection(thread, `memory/scoped/${thread.id}`);
  expect(JSON.stringify(await store.search({ query: "billing email" }))).toContain(
    "finance@example.com",
  );

  const outsider = await recallMemory(db, store, {
    query: "billing email finance@example.com",
    scopes: [{ scopeType: "thread", scopeId: "someone-else" }, { scopeType: "vault" }],
    limit: 8,
  });
  // The outsider may see VAULT memories — that is what vault means, and this
  // fixture's 8-dimensional character-bag embedding makes the page arm return
  // some for any query. What it may not see is anything that is not shared.
  expect(outsider.map((r) => r.memory.scope_type)).toEqual(outsider.map(() => "vault"));
  expect(outsider.map((r) => r.memory.id)).not.toContain(thread.id);
  expect(JSON.stringify(outsider)).not.toContain("finance@example.com");
  // The owner still gets it, from canonical memory rather than from the page.
  const owner = await recallMemory(db, store, {
    query: "billing email",
    scopes: [{ scopeType: "thread", scopeId: "tA" }, { scopeType: "vault" }],
    limit: 8,
  });
  expect(owner.map((r) => r.memory.id)).toContain(thread.id);

  // And `forget` must not have to wait for a maintenance pass to be true: the
  // tool calls projectMemory directly, and that path finds a legacy page by the
  // same two handles the sweep uses, so `forgotten: true` is not a lie on a
  // database that has not been swept yet.
  const revoked = await revokeMemory(db, { memoryId: thread.id, actor: "test" });
  if (!revoked) throw new Error("revoke failed");
  expect((await projectMemory(db, store, revoked)).status).toBe("removed");
  const gone = await db.query("SELECT count(*)::int AS n FROM pages WHERE id = $1", [legacyPage]);
  expect(Number(gone.rows[0].n)).toBe(0);
  // No LIVE page carries the value. The bytes that DO survive are the retracted
  // `.../leftover` row from the test above — the deliberate conservative branch:
  // a page the attribution hint cannot claim might be a user's own note, so it is
  // taken off every read but not destroyed. That is the one place this design
  // leaves private text at rest, and it is reachable by nothing but psql.
  const live = await db.query("SELECT slug FROM pages WHERE deleted_at IS NULL AND body LIKE $1", [
    "%finance@example.com%",
  ]);
  expect(live.rows).toEqual([]);
  expect(await namespaceViolations()).toEqual([]);
});

test("adjacent: more strays than the batch holds, and it still converges", async () => {
  // The sweep is bounded, and a bound is where a repair quietly stops repairing.
  // Three unlinked strays, a batch of ONE, and the invariant has to close anyway —
  // with live pages taken first, so a retracted page can never crowd out a live
  // leak.
  const thread = await memoryRow("user.pager");
  // A mix on purpose: two the tail hint can attribute (purged) and one it cannot
  // (retracted), so the batch has to carry both verdicts.
  const strays = [
    `memory/scoped/${thread.id}`,
    `memory/thread/tb/${thread.id}`,
    `memory/scoped/${thread.id}-orphan`,
  ];
  for (const slug of strays) {
    await db.query(
      `INSERT INTO pages (slug, kind, title, body, content_hash)
       VALUES ($1, 'memory', 'stray', '555-0199 copy', 'legacy')`,
      [slug],
    );
  }
  let passes = 0;
  while ((await namespaceViolations()).length > 0 && passes < 10) {
    await runProjections(db, store, 1);
    passes++;
  }
  // More than one pass really was needed — otherwise this proves nothing about
  // the bound — and it still terminated.
  expect(passes).toBeGreaterThanOrEqual(strays.length);
  expect(passes).toBeLessThan(10);
  expect(await namespaceViolations()).toEqual([]);
  expect(JSON.stringify(await store.search({ query: "555-0199" }))).not.toContain("copy");
});

test("isScopedProjection still answers for the shared read surface, and covers every old shape", async () => {
  // mcp.ts applies this at its tools/call dispatcher. It is now belt-and-braces —
  // the pages it names do not exist after a sweep — but a database mid-migration
  // is exactly when a reader needs it, so it must cover the shapes the sweep is
  // still working through, not just the newest one.
  expect(isScopedProjection("memory/scoped/abc")).toBe(true);
  expect(isScopedProjection("memory/thread/ta/abc")).toBe(true);
  expect(isScopedProjection("memory/agent/a7/abc")).toBe(true);
  expect(isScopedProjection("memory/recipes/sourdough")).toBe(true);
  expect(isScopedProjection("memory/vault/abc")).toBe(false);
  expect(isScopedProjection("notes/anything")).toBe(false);
});
