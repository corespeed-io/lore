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
import { handleRpc } from "../src/server/mcp.js";
import { appendConversationEvent, ensureThread } from "../src/server/memory/events.js";
import { deterministicExtractor, runExtraction } from "../src/server/memory/extract.js";
import { type MemoryItem, revokeMemory, writeMemory } from "../src/server/memory/items.js";
import {
  migrateMemoryNamespace,
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
  // Which database. Defaults to the shared one; the boot-repair tests below need
  // their own, because they are about what happens when a brain is OPENED.
  on: Db = db,
): Promise<number> {
  const { body } = renderProjection(memory);
  const res = await on.query(
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
  await on.query(
    `UPDATE memory_items
     SET projection_page_id = $2, projection_status = $3 WHERE id = $1`,
    [memory.id, link ? pageId : null, link ? "ok" : "removed"],
  );
  return pageId;
}

// A brain of its own, opened the way production opens one. The boot-repair tests
// cannot share the module-level database, because they are about what initSchema
// does to a database that ALREADY holds legacy projections — `boot()` is a second
// process (or a fresh Workers isolate) opening the same one.
async function freshBrain(): Promise<{
  lite: PGlite;
  db: Db;
  store: Store;
  boot: () => Promise<void>;
}> {
  const lite = new PGlite({ extensions: { vector, pg_trgm } });
  const own = pgliteDb(lite);
  const boot = () => initSchema(own, { embeddingModel: "fake", embeddingDim: DIM });
  await boot();
  return { lite, db: own, store: createStore(own, embed), boot };
}

// The shared read surface, reached exactly the way /api/mcp reaches it: one
// bearer for every agent and every thread, access 'read', no scope argument
// anywhere. The refutation was written against this dispatcher, so the probe is
// the dispatcher and not the store.
async function sharedRead(
  ctx: { db: Db; store: Store },
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const rpc = await handleRpc(() => Promise.resolve(ctx), "read", "tools/call", {
    name,
    arguments: args,
  });
  return JSON.stringify(rpc);
}

// The invariant, as one query. Returns every violation in EITHER direction, so a
// hole cannot hide behind a passing count.
async function namespaceViolations(on: Db = db): Promise<string[]> {
  const res = await on.query(
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
  // "admin:test", not "test": items.ts now classifies authority from an ENUMERATED
  // registry instead of a deny-list on the "tool:" prefix, so an unregistered name
  // is the agent surface and may not retire what the user stated. These tests stand
  // in for an in-repo caller, which is what "admin:" says.
  const revoked = await revokeMemory(db, { memoryId: memory.id, actor: "admin:test" });
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
  const revoked = await revokeMemory(db, { memoryId: thread.id, actor: "admin:test" });
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

// --- the mid-migration window, closed at the door -----------------------------

test("THE REFUTATION, verbatim: on the FIRST request after a deploy, the shared surface has nothing", async () => {
  // Verbatim from the adversary: "with a legacy page at memory/scoped/<privId>
  // present and NO sweep yet run — i.e. the exact state of any existing brain on
  // the first request after deploying round 3 — handleRpc(access='read','search',
  // {query:'<canary>'}) returns the thread-scoped memory's rendered body verbatim;
  // get_page on the raw slug returns it; list_pages{kind:'memory'} lists the
  // memory id." And: "This is not transient. runProjections is reachable only from
  // POST /api/maintenance, which needs the WRITE bearer … Until an operator wires a
  // scheduler, every holder of the shared BRAIN_READ_TOKEN reads every other
  // thread's and agent's memories."
  //
  // Nothing below calls runProjections, and nothing below presents a write bearer.
  // The only thing that happens between the leak and the probes is boot() — a new
  // process opening the same database, which is what a deploy is.
  const brain = await freshBrain();
  try {
    const ctx = { db: brain.db, store: brain.store };
    await ensureThread(brain.db, "tR");
    const ev = await appendConversationEvent(brain.db, {
      threadId: "tR",
      eventType: "user_message",
      content: "The reading-room canary is marmalade-pelican-77.",
    });
    const thread = await writeMemory(brain.db, {
      scopeType: "thread",
      scopeId: "tR",
      memoryType: "semantic",
      memoryKey: "room.canary",
      content: "the reading-room canary is marmalade-pelican-77",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const agent = await writeMemory(brain.db, {
      scopeType: "agent",
      scopeId: "agent-r",
      memoryType: "preference",
      memoryKey: "user.subjects",
      content: "prefers zamboni-lowercase commit subjects",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const threadMemory = thread.memory;
    const agentMemory = agent.memory;
    if (!threadMemory || !agentMemory) throw new Error("memories were not committed");

    // BOTH legacy shapes, because a migration that only knows the newest one is
    // not a migration: memory/scoped/<id> (2befdf4) and
    // memory/thread/<scope>/<id> (86abe92).
    const scopedSlug = `memory/scoped/${threadMemory.id}`;
    const threadSlug = `memory/agent/agent-r/${agentMemory.id}`;
    await legacyProjection(threadMemory, scopedSlug, true, brain.db);
    await legacyProjection(agentMemory, threadSlug, false, brain.db);

    // The leak, observed through the shared dispatcher exactly as reported.
    expect(await sharedRead(ctx, "search", { query: "marmalade-pelican-77" })).toContain(
      "marmalade-pelican-77",
    );
    expect(await sharedRead(ctx, "get_page", { slug: scopedSlug })).toContain(
      "marmalade-pelican-77",
    );
    expect(await sharedRead(ctx, "list_pages", { kind: "memory" })).toContain(threadMemory.id);
    expect(await sharedRead(ctx, "search", { query: "zamboni-lowercase" })).toContain(
      "zamboni-lowercase",
    );

    // A deploy. One process boot, no bearer, no scheduler, no maintenance call.
    await brain.boot();

    // Probes that do NOT name a memory id in the request, so the id appearing in
    // the answer would be the oracle the refutation described ("list_pages
    // {kind:'memory'} lists the memory id").
    for (const probe of [
      ["search", { query: "marmalade-pelican-77" }],
      ["search", { query: "zamboni-lowercase" }],
      ["search", { query: "canary" }],
      ["get_page", { slug: "marmalade", fuzzy: true }],
      ["list_pages", { kind: "memory" }],
      ["list_pages", {}],
      ["find_orphans", {}],
    ] as [string, Record<string, unknown>][]) {
      const dump = await sharedRead(ctx, probe[0], probe[1]);
      expect(dump).not.toContain("marmalade-pelican-77");
      expect(dump).not.toContain("zamboni-lowercase");
      expect(dump).not.toContain(threadMemory.id);
      expect(dump).not.toContain(agentMemory.id);
    }
    // Probes that DO name the address. A not_found that quotes the caller's own
    // slug back is not an oracle — the caller supplied it — so the assertion here
    // is about the content and about the answer being indistinguishable from a
    // memory that was never written.
    for (const slug of [scopedSlug, threadSlug]) {
      const page = await sharedRead(ctx, "get_page", { slug });
      expect(page).not.toContain("marmalade-pelican-77");
      expect(page).not.toContain("zamboni-lowercase");
      expect(page).toContain("not_found");
      for (const name of ["get_backlinks", "traverse_graph"]) {
        const dump = await sharedRead(ctx, name, { slug });
        expect(dump).not.toContain("marmalade-pelican-77");
        expect(dump).not.toContain("zamboni-lowercase");
      }
    }
    // Gone as ROWS, both shapes: attributable to a memory that may not own the
    // address, so a soft delete would have left the private value in pages.body.
    const rows = await brain.db.query("SELECT count(*)::int AS n FROM pages WHERE slug LIKE $1", [
      "memory/%",
    ]);
    expect(Number(rows.rows[0].n)).toBe(0);
    const bodies = await brain.db.query(
      "SELECT count(*)::int AS n FROM pages WHERE body LIKE $1 OR body LIKE $2",
      ["%marmalade-pelican-77%", "%zamboni-lowercase%"],
    );
    expect(Number(bodies.rows[0].n)).toBe(0);

    // Removal, not forgetting: both memories are still recallable in their own
    // scope, through the canonical arm.
    expect(
      (
        await recallMemory(brain.db, brain.store, {
          query: "reading-room canary",
          scopes: [{ scopeType: "thread", scopeId: "tR" }],
        })
      ).map((r) => r.memory.id),
    ).toEqual([threadMemory.id]);
    expect(
      (
        await recallMemory(brain.db, brain.store, {
          query: "commit subjects",
          scopes: [{ scopeType: "agent", scopeId: "agent-r" }],
        })
      ).map((r) => r.memory.id),
    ).toEqual([agentMemory.id]);
  } finally {
    await brain.lite.close();
  }
});

test("the verdict comes from the EVIDENCE that identified the page, not from the slug's shape", async () => {
  // The adversary's second finding: pagesOwnedBy finds a page two ways, and a page
  // found by the memory's OWN projection_page_id — positive identification, which
  // is the entire reason that column exists — was still downgraded to 'retract'
  // whenever its slug happened not to end in '/<id>'. That is exactly the
  // renamed-out-of-the-namespace case, and it is the worst one to be soft about:
  // the store's reserved-namespace guard keys on the slug, so a retracted page
  // sitting OUTSIDE memory/ is revived by an ordinary restore_page call.
  const brain = await freshBrain();
  try {
    await ensureThread(brain.db, "tE");
    const ev = await appendConversationEvent(brain.db, {
      threadId: "tE",
      eventType: "user_message",
      content: "My rowing club login name is bramble-otter-12.",
    });
    const priv = await writeMemory(brain.db, {
      scopeType: "thread",
      scopeId: "tE",
      memoryType: "semantic",
      memoryKey: "club.login",
      content: "rowing club login name is bramble-otter-12",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const memory = priv.memory;
    if (!memory) throw new Error("memory was not committed");

    // A projection renamed OUT of the namespace by a release whose rename guard
    // was missing. The address hint cannot attribute it — its last segment is
    // "kidnapped" — so the ONLY thing that ties it to the memory is the recorded
    // link, which is the whole point.
    const outside = "notes/kidnapped-thread-projection";
    const pageId = await legacyProjection(memory, outside, true, brain.db);
    expect(JSON.stringify(await brain.store.getPage({ slug: outside }))).toContain(
      "bramble-otter-12",
    );

    await runProjections(brain.db, brain.store, 50);

    // PURGED, not retracted: the memory itself said this page was its projection,
    // and that memory may own no page at all.
    // Asserted BEFORE the row count on purpose: this is what the weaker verdict
    // actually cost. With the row merely soft-deleted, restore_page brings the
    // content back — `notes/…` is not a reserved slug, so the store's namespace
    // guard never fires and restorePage happily re-puts the body it kept. Putting
    // it first means a regression is reported as the revival it is rather than as
    // an unexpected number.
    await expect(brain.store.restorePage({ slug: outside })).rejects.toThrow(/not_found/);
    const rows = await brain.db.query("SELECT count(*)::int AS n FROM pages WHERE id = $1", [
      pageId,
    ]);
    expect(Number(rows.rows[0].n)).toBe(0);
    const bodies = await brain.db.query("SELECT count(*)::int AS n FROM pages WHERE body LIKE $1", [
      "%bramble-otter-12%",
    ]);
    expect(Number(bodies.rows[0].n)).toBe(0);
    // Still the owner's, from canonical memory.
    expect(
      (
        await recallMemory(brain.db, brain.store, {
          query: "rowing club login",
          scopes: [{ scopeType: "thread", scopeId: "tE" }],
        })
      ).length,
    ).toBe(1);

    // The same rule from the other side, so this is about evidence and not about
    // "private content is purged": a VAULT memory's page renamed out of the
    // namespace is purged too — it is a derived artifact at an address its memory
    // does not own — and the next pass rebuilds it at the canonical address.
    const ev2 = await appendConversationEvent(brain.db, {
      threadId: "tE",
      eventType: "user_message",
      content: "The house cocktail is a gimlet.",
    });
    const shared = await writeMemory(brain.db, {
      scopeType: "vault",
      memoryType: "semantic",
      memoryKey: "vault.cocktail",
      content: "the house cocktail is a gimlet",
      sourceEventIds: [ev2.event.id],
      explicit: true,
    });
    const sharedMemory = shared.memory;
    if (!sharedMemory) throw new Error("memory was not committed");
    const canonical = projectionSlug(sharedMemory);
    if (!canonical) throw new Error("a vault memory must have an address");
    expect((await projectMemory(brain.db, brain.store, sharedMemory)).status).toBe("ok");
    await brain.store.renamePage({ slug: canonical, to: "notes/cocktail-moved" });

    await runProjections(brain.db, brain.store, 50);
    await expect(brain.store.getPage({ slug: "notes/cocktail-moved" })).rejects.toThrow(
      /not_found/,
    );
    expect(
      Number(
        (
          await brain.db.query("SELECT count(*)::int AS n FROM pages WHERE slug = $1", [
            "notes/cocktail-moved",
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
    expect(String((await brain.store.getPage({ slug: canonical })).body)).toContain("gimlet");
  } finally {
    await brain.lite.close();
  }
});

test("BOUNDED WORK: more legacy projections than a batch holds, and ONE boot still finishes", async () => {
  // A migration must finish. This one pages by page id and resumes past the
  // highest it judged, so N legacy pages cost ceil(N / 200) round trips and the
  // loop cannot be starved by rows it can never act on. 205 is deliberately just
  // over the batch: one batch would leave five readable, and "loop until nothing
  // changes" would stop early the moment a batch filled with inert rows.
  const brain = await freshBrain();
  try {
    await ensureThread(brain.db, "tB");
    const ev = await appendConversationEvent(brain.db, {
      threadId: "tB",
      eventType: "user_message",
      content: "My locker code is thistle-badger-31.",
    });
    const priv = await writeMemory(brain.db, {
      scopeType: "thread",
      scopeId: "tB",
      memoryType: "semantic",
      memoryKey: "gym.locker",
      content: "locker code is thistle-badger-31",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const memory = priv.memory;
    if (!memory) throw new Error("memory was not committed");

    // FIRST, and this is the part a "stop when a pass changes nothing" loop gets
    // wrong: 201 pages that are ALREADY retracted and that nothing claims. They
    // are permanently in the candidate set (their state can never agree with a
    // memory that does not exist) and permanently inert (retracting a retracted
    // page is a no-op, and destroying it is the one thing this design refuses).
    // Lowest ids, so they sort first among dead rows.
    await brain.db.query(
      `INSERT INTO pages (slug, kind, title, body, content_hash, deleted_at)
       SELECT 'memory/attic/' || g, 'note', 'attic', 'a note the user wrote', 'legacy', now()
         FROM generate_series(1, 201) AS g`,
    );
    // …then ONE retracted page that IS attributable, behind all of them. Its bytes
    // are a private memory's rendered body, so it must be purged, and a loop that
    // stops the first time a batch changes nothing never reaches it.
    await brain.db.query(
      `INSERT INTO pages (slug, kind, title, body, content_hash, deleted_at)
       VALUES ('memory/scoped/' || $1, 'memory', 'legacy',
               'locker code is thistle-badger-31', 'legacy', now())`,
      [memory.id],
    );
    // …and 205 LIVE ones, all ending in the same memory id so every one is
    // attributable and must be purged. 205 is deliberately just over the batch:
    // a repair that does one batch and stops leaves five readable.
    await brain.db.query(
      `INSERT INTO pages (slug, kind, title, body, content_hash)
       SELECT 'memory/thread/t' || g || '/' || $1, 'memory', 'legacy',
              'locker code is thistle-badger-31', 'legacy'
         FROM generate_series(1, 205) AS g`,
      [memory.id],
    );
    // Plus one live page the address hint cannot claim, so a single batch carries
    // both verdicts rather than only the one the fixture happened to produce.
    await brain.db.query(
      `INSERT INTO pages (slug, kind, title, body, content_hash)
       VALUES ('memory/recipes/brine', 'note', 'Brine', 'A note the user wrote.', 'legacy')`,
    );
    expect(await namespaceViolations(brain.db)).not.toEqual([]);

    await brain.boot();

    expect(await namespaceViolations(brain.db)).toEqual([]);
    expect(
      Number(
        (
          await brain.db.query(
            "SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'memory/thread/%'",
          )
        ).rows[0].n,
      ),
    ).toBe(0);
    // The starved row: judged, and purged, even though it sat behind a full batch
    // of rows the sweep can do nothing about and even though it was already off
    // every read. Its bytes were a private memory's, and "already retracted" is
    // not the same as "gone".
    expect(
      Number(
        (
          await brain.db.query("SELECT count(*)::int AS n FROM pages WHERE slug = $1", [
            `memory/scoped/${memory.id}`,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
    // …while the 201 inert rows it had to page past are untouched, because they may
    // be the user's own notes.
    expect(
      Number(
        (
          await brain.db.query(
            "SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'memory/attic/%'",
          )
        ).rows[0].n,
      ),
    ).toBe(201);
    expect(
      JSON.stringify(
        await sharedRead({ db: brain.db, store: brain.store }, "search", {
          query: "thistle-badger-31",
        }),
      ),
    ).not.toContain("thistle-badger-31");
    // The user's own note under memory/ survived as bytes and is off every read.
    const kept = await brain.db.query(
      "SELECT body, deleted_at FROM pages WHERE slug = 'memory/recipes/brine'",
    );
    expect(String(kept.rows[0].body)).toContain("the user wrote");
    expect(kept.rows[0].deleted_at).not.toBeNull();

    // And a second boot is a no-op, not a re-migration: the inert retracted row
    // does not keep the loop alive.
    await brain.boot();
    expect(await namespaceViolations(brain.db)).toEqual([]);
  } finally {
    await brain.lite.close();
  }
});

test("FAILS CLOSED: a brain whose namespace could not be repaired does not open", async () => {
  // The repair is only a boundary if a failure denies. `failed` counters and a
  // logged warning would leave the leak readable and the brain up, which is the
  // shape of every "we noticed and carried on" defect. initSchema is on the one
  // path to a Store, so throwing here is what turns a wedged row into a 500 for
  // every reader instead of one thread's memories for all of them.
  const brain = await freshBrain();
  try {
    await brain.db.query(
      `INSERT INTO pages (slug, kind, title, body, content_hash)
       VALUES ('memory/scoped/wedged-1', 'memory', 'leftover', 'canary quernstone-49', 'legacy')`,
    );
    // A database where the retract cannot land: a lock timeout, a trigger, a
    // read-only replica. applyVerdict's soft delete is the transaction.
    const wedged: Db = {
      query: brain.db.query,
      tx: async () => {
        throw new Error("could not obtain lock");
      },
    };
    await expect(migrateMemoryNamespace(wedged)).rejects.toThrow(/namespace not repaired/);
    // Named, so an operator knows which row: the message carries the slug.
    await expect(migrateMemoryNamespace(wedged)).rejects.toThrow(/memory\/scoped\/wedged-1/);
    // The whole door, not just the helper: opening the brain is what must fail.
    await expect(initSchema(wedged, { embeddingModel: "fake", embeddingDim: DIM })).rejects.toThrow(
      /namespace not repaired/,
    );
    // The throw was not cosmetic — the page really is still live, which is exactly
    // why the answer had to be "do not open".
    const live = await brain.db.query(
      "SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'memory/%' AND deleted_at IS NULL",
    );
    expect(Number(live.rows[0].n)).toBe(1);
    // A healthy database repairs it and opens.
    await brain.boot();
    expect(await namespaceViolations(brain.db)).toEqual([]);
    expect(
      JSON.stringify(
        await sharedRead({ db: brain.db, store: brain.store }, "search", {
          query: "quernstone-49",
        }),
      ),
    ).not.toContain("quernstone-49");
  } finally {
    await brain.lite.close();
  }
});

// --- self-attack: paths nobody handed me --------------------------------------

test("adjacent: the JS chokepoint and its SQL mirror answer the same question, for every scope AND status", async () => {
  // The risk this fix ADDS. projectionSlug (JS) and ADDRESS_SQL (the interpolated
  // mirror) have always been two readers of one rule, but the mirror used to be a
  // candidate filter only — "the worst a drift can do is delay a repair". The boot
  // repair's exit check now uses it as an AUTHORITY: a drift that made the mirror
  // miss a leak would make the brain open on one. Both are derived from
  // SHARED_SCOPE so they cannot be edited apart, and a comment saying so is worth
  // less than a check, so this plants a page at the only shape the mirror can
  // produce for a memory in every scope and every status and compares the answer
  // with projectionSlug's.
  const brain = await freshBrain();
  try {
    await ensureThread(brain.db, "tM");
    const ev = await appendConversationEvent(brain.db, {
      threadId: "tM",
      eventType: "user_message",
      content: "Assorted facts for the mirror test.",
    });
    const cases: { scopeType: "vault" | "thread" | "agent"; status: string; readable: boolean }[] =
      [
        { scopeType: "vault", status: "committed", readable: true },
        { scopeType: "vault", status: "revoked", readable: false },
        { scopeType: "vault", status: "candidate", readable: false },
        { scopeType: "vault", status: "superseded", readable: false },
        { scopeType: "thread", status: "committed", readable: false },
        { scopeType: "agent", status: "committed", readable: false },
      ];
    const planted: { id: string; readable: boolean; shared: boolean; canonical: boolean }[] = [];
    for (const [i, c] of cases.entries()) {
      const written = await writeMemory(brain.db, {
        scopeType: c.scopeType,
        scopeId: c.scopeType === "vault" ? undefined : `s-${i}`,
        memoryType: "semantic",
        memoryKey: `mirror.case_${i}`,
        content: `mirror case ${i} tarragon-${i}`,
        sourceEventIds: [ev.event.id],
        explicit: true,
      });
      const memory = written.memory;
      if (!memory) throw new Error(`case ${i} was not committed`);
      if (c.status !== "committed") {
        await brain.db.query("UPDATE memory_items SET status = $2 WHERE id = $1", [
          memory.id,
          c.status,
        ]);
      }
      // The JS half, before anything touches the database.
      expect(projectionSlug(memory)).toBe(
        c.scopeType === "vault" ? `memory/vault/${memory.id}` : null,
      );
      await brain.db.query(
        `INSERT INTO pages (slug, kind, title, body, content_hash)
         VALUES ('memory/vault/' || $1, 'memory', 'mirror', $2, 'legacy')`,
        [memory.id, `mirror case ${i} tarragon-${i}`],
      );
      planted.push({
        id: memory.id,
        readable: c.readable,
        shared: c.scopeType === "vault",
        canonical: c.scopeType === "vault",
      });
    }

    await brain.boot();

    for (const [i, p] of planted.entries()) {
      const row = await brain.db.query(
        "SELECT deleted_at FROM pages WHERE slug = 'memory/vault/' || $1",
        [p.id],
      );
      if (p.readable) {
        expect(row.rows.length).toBe(1);
        expect(row.rows[0].deleted_at).toBeNull();
      } else if (p.canonical) {
        // Its memory owns this exact address but is not committed: retract, so a
        // re-commit revives it through the same stable slug.
        expect(row.rows.length).toBe(1);
        expect(row.rows[0].deleted_at).not.toBeNull();
      } else {
        // Its memory may own no address at all: the ROW must not exist.
        expect(row.rows.length).toBe(0);
      }
      const dump = await sharedRead({ db: brain.db, store: brain.store }, "search", {
        query: `tarragon-${i}`,
      });
      expect(dump.includes(`tarragon-${i}`)).toBe(p.readable);
    }
  } finally {
    await brain.lite.close();
  }
});

test("adjacent: the sweep's retract leaves exactly the state store.deletePage leaves", async () => {
  // The one place this fix deliberately keeps two implementations: applyVerdict
  // cannot call store.deletePage, because the boot repair has no Store and no
  // embeddings provider to build one with, so "retract" is spelled once there and
  // once here. It is a MECHANISM, not a rule — a divergence leaves derived rows
  // behind, it cannot make a page readable — but the comment claiming they agree is
  // worth less than a check that they do. Two pages with identical bodies: one
  // taken down by store.deletePage, one by the sweep.
  const brain = await freshBrain();
  try {
    await ensureThread(brain.db, "tD");
    const ev = await appendConversationEvent(brain.db, {
      threadId: "tD",
      eventType: "user_message",
      content: "The good knife lives in the second drawer.",
    });
    const written = await writeMemory(brain.db, {
      scopeType: "vault",
      memoryType: "semantic",
      memoryKey: "vault.knife",
      content: "the good knife lives in the second drawer",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const memory = written.memory;
    if (!memory) throw new Error("memory was not committed");
    const slug = projectionSlug(memory);
    if (!slug) throw new Error("a vault memory must have an address");
    expect((await projectMemory(brain.db, brain.store, memory)).status).toBe("ok");
    // The twin: the same body at an ordinary slug, so the chunk counts start equal.
    const twinBody = renderProjection(memory).body;
    await brain.store.putPage({ slug: "notes/knife-twin", body: twinBody });

    const state = async (s: string) =>
      (
        await brain.db.query(
          `SELECT (p.deleted_at IS NOT NULL) AS gone, (p.updated_at > p.created_at) AS touched,
                  p.body, p.kind, p.frontmatter,
                  (SELECT count(*)::int FROM chunks c WHERE c.page_id = p.id) AS chunks
             FROM pages p WHERE p.slug = $1`,
          [s],
        )
      ).rows[0];
    const beforeTwin = await state("notes/knife-twin");
    const beforeProjection = await state(slug);
    expect(Number(beforeTwin.chunks)).toBe(Number(beforeProjection.chunks));
    expect(Number(beforeTwin.chunks)).toBeGreaterThan(0);

    await brain.store.deletePage({ slug: "notes/knife-twin" });
    const revoked = await revokeMemory(brain.db, { memoryId: memory.id, actor: "admin:test" });
    if (!revoked) throw new Error("revoke failed");
    await runProjections(brain.db, brain.store, 50);

    const afterTwin = await state("notes/knife-twin");
    const afterProjection = await state(slug);
    // Same row survival, same soft-delete flag, same chunk teardown, same bytes.
    expect(afterProjection.gone).toBe(afterTwin.gone);
    expect(afterProjection.gone).toBe(true);
    expect(Number(afterProjection.chunks)).toBe(Number(afterTwin.chunks));
    expect(Number(afterProjection.chunks)).toBe(0);
    expect(String(afterProjection.body)).toBe(String(beforeProjection.body));
    expect(afterProjection.touched).toBe(true);
    // And revivable through the same stable slug, which is what retract is FOR.
    await runProjections(brain.db, brain.store, 50);
    await brain.db.query("UPDATE memory_items SET status = 'committed' WHERE id = $1", [memory.id]);
    await runProjections(brain.db, brain.store, 50);
    expect(String((await brain.store.getPage({ slug })).body)).toContain("second drawer");
  } finally {
    await brain.lite.close();
  }
});

test("adjacent: the window this design still has, named — and it closes on a pass, not on a read filter", async () => {
  // Honest scope statement, because the deleted predicate was pretending to cover
  // this. The boot repair closes the window between a deploy and the first request.
  // It cannot close the window between one boot and a row inserted by psql AFTER
  // it: there is no read-time filter any more, and adding one back is the shape
  // round 2 lost with. So what has to hold is (a) no supported write path can open
  // that window and (b) the ordinary maintenance pass closes it with no redeploy.
  const brain = await freshBrain();
  try {
    await ensureThread(brain.db, "tW");
    const ev = await appendConversationEvent(brain.db, {
      threadId: "tW",
      eventType: "user_message",
      content: "My bicycle lock spells out fennel-marlin-04.",
    });
    const priv = await writeMemory(brain.db, {
      scopeType: "thread",
      scopeId: "tW",
      memoryType: "semantic",
      memoryKey: "bike.lock",
      content: "bicycle lock spells out fennel-marlin-04",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const memory = priv.memory;
    if (!memory) throw new Error("memory was not committed");
    const slug = `memory/scoped/${memory.id}`;
    const body = renderProjection(memory).body;

    // (a) No supported door opens it — the store, and the dispatcher in front of it.
    await expect(brain.store.putPage({ slug, body })).rejects.toThrow(/reserved/);
    await expect(brain.store.putPage({ slug: ` ${slug}`, body })).rejects.toThrow(/reserved/);
    await expect(brain.store.restorePage({ slug })).rejects.toThrow();
    await brain.store.putPage({ slug: "notes/bike", body: "ordinary" });
    await expect(brain.store.renamePage({ slug: "notes/bike", to: slug })).rejects.toThrow(
      /reserved/,
    );
    const write = async (name: string, args: Record<string, unknown>) => {
      const rpc = await handleRpc(
        () => Promise.resolve({ db: brain.db, store: brain.store }),
        "write",
        "tools/call",
        { name, arguments: args },
      );
      return JSON.stringify(rpc);
    };
    expect(await write("put_page", { slug, body })).toContain("reserved");
    expect(await write("put_page", { slug: "notes/oracle", body: `see [[${slug}]]` })).toContain(
      "reserved",
    );

    // (b) psql, though. This is the residual window, stated rather than papered
    // over: the row is live and the shared surface answers with it.
    await legacyProjection(memory, slug, true, brain.db);
    expect(
      await sharedRead({ db: brain.db, store: brain.store }, "search", {
        query: "fennel-marlin-04",
      }),
    ).toContain("fennel-marlin-04");

    // …and it closes on the ordinary maintenance pass, with no redeploy and no
    // second mechanism: the same sweep, bounded, that the boot repair loops.
    const swept = await runProjections(brain.db, brain.store, 50);
    expect(swept.namespace.purged).toBe(1);
    expect(
      await sharedRead({ db: brain.db, store: brain.store }, "search", {
        query: "fennel-marlin-04",
      }),
    ).not.toContain("fennel-marlin-04");
    expect(await namespaceViolations(brain.db)).toEqual([]);
    // …and a boot would have closed it too, which is what makes the two paths one
    // repair rather than two.
    await legacyProjection(memory, slug, false, brain.db);
    await brain.boot();
    expect(
      await sharedRead({ db: brain.db, store: brain.store }, "search", {
        query: "fennel-marlin-04",
      }),
    ).not.toContain("fennel-marlin-04");
  } finally {
    await brain.lite.close();
  }
});

test("REPLACES the isScopedProjection unit test: the shape list moved onto what decides", async () => {
  // CHANGED DELIBERATELY, and not loosened. The old test asserted
  // isScopedProjection's return values for five slug shapes. That function is
  // deleted: its comment claimed mcp.ts's dispatcher applied it "while a database
  // is still mid-migration", and grep found ZERO callers in src/ — the only caller
  // was this test. A predicate whose only caller is its own test is a claim, not a
  // defence, and this one was standing in for the round-2 read filter that had been
  // removed, so the shape list was reading as coverage of a window nothing guarded.
  //
  // The shapes still matter, so they are asserted against the two things that do
  // decide: projectionSlug (no non-shared memory owns ANY address, at any shape)
  // and the boot repair (no page in the namespace is readable when the brain
  // opens). Every shape the old test listed is here, plus the vault control.
  const brain = await freshBrain();
  try {
    await ensureThread(brain.db, "tS");
    const ev = await appendConversationEvent(brain.db, {
      threadId: "tS",
      eventType: "user_message",
      content: "The shed combination is walnut-heron-58.",
    });
    const priv = await writeMemory(brain.db, {
      scopeType: "agent",
      scopeId: "a7",
      memoryType: "semantic",
      memoryKey: "shed.combination",
      content: "shed combination is walnut-heron-58",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const shared = await writeMemory(brain.db, {
      scopeType: "vault",
      memoryType: "semantic",
      memoryKey: "vault.shed",
      content: "the shed is behind the garage",
      sourceEventIds: [ev.event.id],
      explicit: true,
    });
    const memory = priv.memory;
    const sharedMemory = shared.memory;
    if (!memory || !sharedMemory) throw new Error("memories were not committed");

    // The chokepoint: not a shape test, an OWNERSHIP test. A non-shared memory
    // owns nothing, so there is no address for any shape to be judged at.
    expect(projectionSlug(memory)).toBeNull();
    expect(projectionSlug(sharedMemory)).toBe(`memory/vault/${sharedMemory.id}`);

    for (const slug of [
      `memory/scoped/${memory.id}`,
      `memory/thread/ts/${memory.id}`,
      `memory/agent/a7/${memory.id}`,
      "memory/recipes/sourdough",
    ]) {
      await brain.db.query(
        `INSERT INTO pages (slug, kind, title, body, content_hash)
         VALUES ($1, 'memory', 'legacy', 'shed combination is walnut-heron-58', 'legacy')`,
        [slug],
      );
    }
    await projectMemory(brain.db, brain.store, sharedMemory);
    await brain.boot();

    const ctx = { db: brain.db, store: brain.store };
    for (const slug of [
      `memory/scoped/${memory.id}`,
      `memory/thread/ts/${memory.id}`,
      `memory/agent/a7/${memory.id}`,
      "memory/recipes/sourdough",
    ]) {
      const dump = await sharedRead(ctx, "get_page", { slug });
      expect(dump).not.toContain("walnut-heron-58");
      expect(dump).toContain("not_found");
    }
    expect(await sharedRead(ctx, "search", { query: "walnut-heron-58" })).not.toContain(
      "walnut-heron-58",
    );
    // The vault control: memory/vault/<id> is the one shape that IS readable, and
    // the repair must not have taken it. A sweep that removed everything would
    // pass every assertion above and be useless.
    expect(
      await sharedRead(ctx, "get_page", { slug: `memory/vault/${sharedMemory.id}` }),
    ).toContain("behind the garage");
    expect(await namespaceViolations(brain.db)).toEqual([]);
  } finally {
    await brain.lite.close();
  }
});
