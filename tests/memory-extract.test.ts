// Extraction scope, against a real store (PGlite = Postgres 17).
//
// One invariant, and it is a privacy invariant rather than a modelling nicety:
// extraction may never pick a scope WIDER than the event it read. A statement
// made in one thread that lands at vault scope is readable from every other
// thread and every agent — the leak this file exists to keep closed.

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import { appendConversationEvent, ensureThread } from "../src/server/memory/events.js";
import { deterministicExtractor, runExtraction } from "../src/server/memory/extract.js";
import { getActiveByKey, writeMemory } from "../src/server/memory/items.js";
import { runProjections } from "../src/server/memory/projection.js";
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

beforeEach(async () => {
  pg = new PGlite({ extensions: { vector, pg_trgm } });
  db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  store = createStore(db, embed);
});
afterEach(async () => {
  await pg.close();
});

// Exactly what maintenance.ts offers a sweep: this thread, and the vault.
const sweepScopes = (threadId: string) => [
  { scopeType: "thread" as const, scopeId: threadId },
  { scopeType: "vault" as const, scopeId: null },
];

async function say(threadId: string, content: string) {
  await ensureThread(db, threadId);
  const { event } = await appendConversationEvent(db, {
    threadId,
    eventType: "user_message",
    content,
  });
  return event;
}

test("a thread statement stays thread-scoped when the vault is also allowed", async () => {
  await say("tA", "My billing email is finance@example.com.");
  const res = await runExtraction(db, deterministicExtractor, {
    threadId: "tA",
    allowedScopes: sweepScopes("tA"),
  });
  expect(res.applied.map((a) => a.status)).toEqual(["committed"]);

  const rows = await db.query(
    "SELECT scope_type, scope_id FROM memory_items WHERE status = 'committed'",
  );
  expect(rows.rows.map((r) => [r.scope_type, r.scope_id])).toEqual([["thread", "tA"]]);
});

test("an agent-scoped source stays agent-scoped", async () => {
  await say("tA", "I prefer concise technical answers.");
  await runExtraction(db, deterministicExtractor, {
    threadId: "tA",
    // Nothing narrower than agent on offer, so agent is the narrowest choice —
    // narrowest-wins must not collapse into "always thread".
    allowedScopes: [
      { scopeType: "agent", scopeId: "agent-1" },
      { scopeType: "vault", scopeId: null },
    ],
  });
  const m = await getActiveByKey(db, {
    scopeType: "agent",
    scopeId: "agent-1",
    memoryType: "preference",
    memoryKey: "user.response_style",
  });
  expect(m?.content).toContain("concise technical answers");
});

test("a memory extracted from thread tA is not recallable from thread tB", async () => {
  await say("tA", "My billing email is finance@example.com.");
  await runExtraction(db, deterministicExtractor, {
    threadId: "tA",
    allowedScopes: sweepScopes("tA"),
  });
  await runProjections(db, store, 50);

  // A sibling thread reading this is the leak. It asks for vault scope too,
  // because a broader scope is legitimately visible from a narrower request —
  // which is exactly why the WRITE has to be the narrow one.
  expect(
    (
      await recallMemory(db, store, {
        query: "billing email",
        scopes: [
          { scopeType: "thread", scopeId: "tB" },
          { scopeType: "vault", scopeId: null },
        ],
      })
    ).length,
  ).toBe(0);
  expect(
    (
      await recallMemory(db, store, {
        query: "billing email",
        scopes: [{ scopeType: "agent", scopeId: "agent-1" }],
      })
    ).length,
  ).toBe(0);
  // …and still readable where it was actually said, or this passes by writing
  // nothing at all.
  expect(
    (
      await recallMemory(db, store, {
        query: "billing email",
        scopes: [{ scopeType: "thread", scopeId: "tA" }],
      })
    ).length,
  ).toBe(1);
});

test("an unlabelled correction in a thread cannot retire a vault fact", async () => {
  // A pre-existing global fact, stated somewhere else entirely.
  const seed = await say("t-vault", "My billing email is old@example.com.");
  const vaultKey = {
    scopeType: "vault" as const,
    scopeId: null,
    memoryType: "semantic" as const,
    memoryKey: "user.billing_email",
  };
  const before = await writeMemory(db, {
    ...vaultKey,
    content: "billing email is old@example.com",
    structuredValue: { field: "billing email", value: "old@example.com" },
    sourceEventIds: [seed.id],
    explicit: true,
  });
  expect(before.status).toBe("committed");

  await say("tA", "Use finance@example.com now.");
  await runExtraction(db, deterministicExtractor, {
    threadId: "tA",
    allowedScopes: sweepScopes("tA"),
  });

  // A SUPERSEDE writes a NEW row in the target's scope, so letting a thread
  // event supersede a vault fact leaks that thread's content globally just as
  // surely as an ADD would.
  const still = await getActiveByKey(db, vaultKey);
  expect(still?.content).toContain("old@example.com");
  const leaked = await db.query(
    "SELECT count(*)::int AS n FROM memory_items WHERE scope_type = 'vault' AND content LIKE '%finance@example.com%'",
  );
  expect(Number(leaked.rows[0].n)).toBe(0);
  expect(still?.id).toBe(before.memory?.id);
});
