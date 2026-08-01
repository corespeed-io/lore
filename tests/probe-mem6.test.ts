// ADVERSARIAL PROBE — round 6, memory layer. DELETE BEFORE FINISHING.
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Db, type Query, initSchema } from "../src/server/db.js";
import type { BrainCtx } from "../src/server/mcp.js";
import { promoteProcedure, recordEpisode } from "../src/server/memory/episodes.js";
import { appendConversationEvent, ensureThread } from "../src/server/memory/events.js";
import { deterministicExtractor, runExtraction } from "../src/server/memory/extract.js";
import {
  type MemoryItem,
  type ScopeType,
  enrichMemory,
  getActiveByKey,
  getMemory,
  statedByUser,
} from "../src/server/memory/items.js";
import { runProjections } from "../src/server/memory/projection.js";
import { MEMORY_TOOLS } from "../src/server/memory/tools.js";
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

let pg: PGlite;
let db: Db;
let store: Store;

beforeEach(async () => {
  pg = new PGlite({ extensions: { vector, pg_trgm } });
  db = pgliteDb(pg);
  await initSchema(db, { embeddingModel: "fake", embeddingDim: DIM });
  store = createStore(db, embed);
});
afterEach(async () => {
  await pg.close();
});

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

async function say(threadId: string, content: string) {
  await ensureThread(db, threadId);
  const { event } = await appendConversationEvent(db, {
    threadId,
    eventType: "user_message",
    content,
  });
  return event;
}

function tool(name: string, args: Record<string, unknown>, ctx?: BrainCtx) {
  return MEMORY_TOOLS[name].handler(ctx ?? { db, store }, args) as Promise<Record<string, unknown>>;
}

async function userMemory(args: {
  threadId: string;
  sentence: string;
  scopeType: ScopeType;
  scopeId: string | null;
  memoryKey: string;
}): Promise<MemoryItem> {
  await say(args.threadId, args.sentence);
  await runExtraction(db, deterministicExtractor, {
    threadId: args.threadId,
    allowedScopes: [{ scopeType: args.scopeType, scopeId: args.scopeId }],
  });
  return must(
    await getActiveByKey(db, {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      memoryType: "semantic",
      memoryKey: args.memoryKey,
    }),
    `${args.scopeType} memory ${args.memoryKey}`,
  );
}

// ---------------------------------------------------------------------------
// 1. inRepoActor / the authority registry
// ---------------------------------------------------------------------------

test("1-mirror: promoteProcedure still SUPERSEDEs a user-stated procedure", async () => {
  const u1 = await say("t1", "My billing email is real@example.com.");
  const ep = async (n: number, evId: string) =>
    must(
      (
        await recordEpisode(db, {
          scopeType: "agent",
          scopeId: "A",
          goal: "deploy the site",
          actions: [`step ${n}`],
          result: "ok",
          success: true,
          sourceEventIds: [evId],
        })
      ).memory,
      "episode",
    );
  const e1 = await ep(1, u1.id);
  const e2 = await ep(2, u1.id);
  const first = await promoteProcedure(db, {
    scopeType: "agent",
    scopeId: "A",
    goalPattern: "deploy the site",
    preconditions: [],
    requiredTools: [],
    requiredPermissions: [],
    steps: ["a"],
    verification: [],
    knownFailureModes: [],
    applicability: "always",
    supportingEpisodeIds: [e1.id, e2.id],
  });
  const p1 = must(first.memory, "procedure v1");
  // The procedure inherits the user's evidence through the episodes.
  expect(await statedByUser(db.query, p1.id)).toBe(true);

  // Second promotion whose evidence is NOT the user's: only the registry entry
  // for `system:procedure-promoter` can authorize the SUPERSEDE.
  await ensureThread(db, "t2", "A");
  const { event: a2 } = await appendConversationEvent(db, {
    threadId: "t2",
    eventType: "agent_action",
    content: "ran the deploy again",
    source: "tool:probe",
  });
  const e3 = await ep(3, a2.id);
  const e4 = await ep(4, a2.id);
  const second = await promoteProcedure(db, {
    scopeType: "agent",
    scopeId: "A",
    goalPattern: "deploy the site",
    preconditions: [],
    requiredTools: [],
    requiredPermissions: [],
    steps: ["a", "b"],
    verification: [],
    knownFailureModes: [],
    applicability: "always",
    supportingEpisodeIds: [e3.id, e4.id],
  });
  expect(second.operation).toBe("SUPERSEDE");
  expect((await getMemory(db, p1.id))?.status).toBe("superseded");
});

test("1-mirror: recordEpisode names itself and is not refused", async () => {
  const u = await say("t1", "My billing email is real@example.com.");
  const r = await recordEpisode(db, {
    scopeType: "agent",
    scopeId: "A",
    goal: "g",
    actions: ["x"],
    result: "ok",
    success: true,
    sourceEventIds: [u.id],
  });
  expect(r.operation).toBe("ADD");
  expect(must(r.memory, "episode").created_by).toBe("system:episode-recorder");
});

test("1-attack: consolidation retires a duplicate WITHOUT the chokepoint", async () => {
  const { consolidateMemory } = await import("../src/server/memory/consolidate.js");
  const { writeMemory } = await import("../src/server/memory/items.js");
  const u = await say("t1", "hello there");
  // Agent's own note first...
  const agentRow = must(
    (
      await writeMemory(db, {
        scopeType: "vault",
        scopeId: null,
        memoryType: "semantic",
        memoryKey: null,
        content: "the office is in Berlin",
        sourceEventIds: [u.id],
        explicit: true,
        createdBy: "tool:remember",
      })
    ).memory,
    "agent row",
  );
  // ...then a SECOND, identical row that the user stated (bypassing the twin
  // merge by giving it a distinct fingerprint via a second event).
  const u2 = await say("t1", "also hello");
  const userRow = must(
    (
      await writeMemory(db, {
        scopeType: "vault",
        scopeId: null,
        memoryType: "semantic",
        memoryKey: null,
        content: "the office is in Berlin",
        sourceEventIds: [u2.id],
        explicit: true,
        createdBy: "extractor:probe",
      })
    ).memory,
    "user row",
  );
  const bothCommitted =
    agentRow.status === "committed" && userRow.status === "committed" && agentRow.id !== userRow.id;
  // CONTROL: the same retirement through the chokepoint, by the same actor,
  // is refused.
  const { amendMemory } = await import("../src/server/memory/items.js");
  await expect(
    db.tx((q) =>
      amendMemory(q, {
        memoryId: userRow.id,
        operation: "SUPERSEDE",
        status: "superseded",
        actor: "consolidation",
        reason: "control",
      }),
    ),
  ).rejects.toThrow(/stated by the user/);

  const report = await consolidateMemory(db, store);
  const after = must(await getMemory(db, userRow.id), "user row after");
  const rev = await db.query(
    "SELECT operation, actor, reason FROM memory_revisions WHERE memory_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userRow.id],
  );
  // eslint-disable-next-line no-console
  console.log("[1-attack] two rows:", bothCommitted, "retired:", report.duplicatesRetired, {
    agent: (await getMemory(db, agentRow.id))?.status,
    user: after.status,
    userStated: await statedByUser(db.query, userRow.id),
    revision: rev.rows[0],
  });
  // Assertion: whatever consolidation does, a user-stated row must not be
  // retired by a path that never asked mayAmend.
  expect(bothCommitted).toBe(true);
  expect(await statedByUser(db.query, userRow.id)).toBe(true);
  expect(after.status).toBe("committed");
});

// ---------------------------------------------------------------------------
// 2. forget's citation scope
// ---------------------------------------------------------------------------

test("2-attack: a vault-scope forget cannot revoke a thread- or agent-scoped memory", async () => {
  const threadMem = await userMemory({
    threadId: "t1",
    sentence: "My billing email is real@example.com.",
    scopeType: "thread",
    scopeId: "t1",
    memoryKey: "user.billing_email",
  });
  const u = await say("t1", "please forget that");
  const r = await tool("forget", {
    scope: "vault",
    memory_id: threadMem.id,
    authorizing_event_ids: [u.id],
  });
  expect(r.revoked).toBe(0);
  expect(r.reason).toBe("not_found");
  expect((await getMemory(db, threadMem.id))?.status).toBe("committed");
});

test("2-attack: an agent-scope forget cannot borrow an UNOWNED thread's user message", async () => {
  await ensureThread(db, "t-agent", "A");
  const mem = await userMemory({
    threadId: "t-agent",
    sentence: "My billing email is real@example.com.",
    scopeType: "agent",
    scopeId: "A",
    memoryKey: "user.billing_email",
  });
  expect(await statedByUser(db.query, mem.id)).toBe(true);
  const borrowed = await say("t-chat", "thanks, that's helpful");
  await expect(
    tool("forget", {
      scope: "agent",
      agent_id: "A",
      thread_id: "t-chat",
      memory_id: mem.id,
      authorizing_event_ids: [borrowed.id],
    }),
  ).rejects.toThrow(/scope can reach/);
  expect((await getMemory(db, mem.id))?.status).toBe("committed");
});

test("2-attack: claiming an unowned thread makes its user messages citable", async () => {
  await ensureThread(db, "t-agent", "A");
  const mem = await userMemory({
    threadId: "t-agent",
    sentence: "My billing email is real@example.com.",
    scopeType: "agent",
    scopeId: "A",
    memoryKey: "user.billing_email",
  });
  const borrowed = await say("t-chat", "thanks, that's helpful");
  // The claim: any successful write naming both fields adopts the thread.
  await tool("append_event", {
    thread_id: "t-chat",
    agent_id: "A",
    event_type: "agent_action",
    content: "noted",
  });
  const owner = (await db.query("SELECT agent_id FROM threads WHERE id = 't-chat'")).rows[0]
    .agent_id;
  const after = await tool("forget", {
    scope: "agent",
    agent_id: "A",
    memory_id: mem.id,
    authorizing_event_ids: [borrowed.id],
  }).catch((e) => ({ error: String(e) }));
  // eslint-disable-next-line no-console
  console.log("[2-claim] owner now:", owner, "forget:", after);
  expect(owner).toBe("A");
  // A different agent is now permanently locked out of that thread.
  await expect(
    tool("append_event", {
      thread_id: "t-chat",
      agent_id: "B",
      event_type: "agent_action",
      content: "hi",
    }),
  ).rejects.toThrow(/another agent/);
});

test("2-mirror: a legitimate revocation works at thread, agent and vault scope", async () => {
  // thread
  const tm = await userMemory({
    threadId: "t1",
    sentence: "My billing email is real@example.com.",
    scopeType: "thread",
    scopeId: "t1",
    memoryKey: "user.billing_email",
  });
  const u1 = await say("t1", "please forget my billing email");
  const r1 = await tool("forget", {
    thread_id: "t1",
    memory_id: tm.id,
    authorizing_event_ids: [u1.id],
  });
  expect(r1.revoked).toBe(1);
  expect(r1.forgotten).toBe(true);
  expect((await getMemory(db, tm.id))?.status).toBe("revoked");

  // agent
  await ensureThread(db, "t2", "A");
  const am = await userMemory({
    threadId: "t2",
    sentence: "My billing email is agent@example.com.",
    scopeType: "agent",
    scopeId: "A",
    memoryKey: "user.billing_email",
  });
  const u2 = await say("t2", "please forget my billing email");
  const r2 = await tool("forget", {
    agent_id: "A",
    memory_id: am.id,
    authorizing_event_ids: [u2.id],
  });
  expect(r2.revoked).toBe(1);
  expect(r2.forgotten).toBe(true);

  // vault, with a projected page that must be retracted
  const vm = await userMemory({
    threadId: "t3",
    sentence: "My billing email is vault@example.com.",
    scopeType: "vault",
    scopeId: null,
    memoryKey: "user.billing_email",
  });
  await runProjections(db, store, 50);
  const projected = must(await getMemory(db, vm.id), "vault memory").projection_page_id;
  expect(projected).not.toBeNull();
  const live = await db.query("SELECT slug FROM pages WHERE id = $1 AND deleted_at IS NULL", [
    projected,
  ]);
  expect(live.rows.length).toBe(1);
  const u3 = await say("t4", "please forget my billing email");
  const r3 = await tool("forget", {
    scope: "vault",
    memory_id: vm.id,
    authorizing_event_ids: [u3.id],
  });
  expect(r3.revoked).toBe(1);
  expect(r3.forgotten).toBe(true);
  const dead = await db.query("SELECT deleted_at FROM pages WHERE id = $1", [projected]);
  expect(dead.rows[0].deleted_at).not.toBeNull();
});

test("2-edges: duplicate, unknown, empty and foreign citation lists", async () => {
  const vm = await userMemory({
    threadId: "t3",
    sentence: "My billing email is vault@example.com.",
    scopeType: "vault",
    scopeId: null,
    memoryKey: "user.billing_email",
  });
  const u = await say("t3", "please forget it");
  // duplicate ids
  await expect(
    tool("forget", {
      scope: "vault",
      memory_id: vm.id,
      authorizing_event_ids: [u.id, u.id],
    }),
  ).rejects.toThrow(/scope can reach/);
  expect((await getMemory(db, vm.id))?.status).toBe("committed");
  // unknown id
  await expect(
    tool("forget", {
      scope: "vault",
      memory_id: vm.id,
      authorizing_event_ids: ["nope"],
    }),
  ).rejects.toThrow(/scope can reach/);
  // empty list == no citation: still refused for a user-stated memory
  await expect(
    tool("forget", { scope: "vault", memory_id: vm.id, authorizing_event_ids: [] }),
  ).rejects.toThrow(/stated by the user/);
  expect((await getMemory(db, vm.id))?.status).toBe("committed");
  // a non-string inside the list
  await expect(
    tool("forget", { scope: "vault", memory_id: vm.id, authorizing_event_ids: [1] }),
  ).rejects.toThrow(/must be a string/);
});

// ---------------------------------------------------------------------------
// 3. argument readers + ordering
// ---------------------------------------------------------------------------

const eventCount = async () =>
  Number(
    (await db.query("SELECT count(*)::int AS n FROM conversation_events")).rows[0].n as number,
  );

test("3: a refused remember leaves nothing durable", async () => {
  const before = await eventCount();
  for (const bad of [
    { content: "x", memory_key: ["k"] },
    { content: "x", memory_type: 7 },
    { content: ["x"] },
    { content: "x", memory_type: "nope" },
  ]) {
    await expect(tool("remember", { thread_id: "t1", ...bad })).rejects.toThrow();
  }
  expect(await eventCount()).toBe(before);
  const threads = await db.query("SELECT id, last_event_sequence FROM threads");
  // eslint-disable-next-line no-console
  console.log("[3-remember] threads after 4 refusals:", threads.rows);
  expect(
    (await db.query("SELECT count(*)::int AS n FROM memory_items")).rows[0].n as number,
  ).toBe(0);
});

test("3: a refused append_event still creates/claims the thread", async () => {
  await expect(
    tool("append_event", { thread_id: "t-new", agent_id: "A", event_type: "bogus" }),
  ).rejects.toThrow();
  const rows = (await db.query("SELECT id, agent_id, last_event_sequence FROM threads")).rows;
  // eslint-disable-next-line no-console
  console.log("[3-append] threads after a refused append_event:", rows);
  expect(await eventCount()).toBe(0);
  // The refusal wrote a threads row and an ownership claim.
  expect(rows.length).toBe(1);
  expect(rows[0].agent_id).toBe("A");

  // And it can adopt a thread that already exists and is unowned.
  await say("t-pre", "hello");
  await expect(
    tool("append_event", { thread_id: "t-pre", agent_id: "Z", event_type: "bogus" }),
  ).rejects.toThrow();
  const claimed = (await db.query("SELECT agent_id FROM threads WHERE id = 't-pre'")).rows[0];
  // eslint-disable-next-line no-console
  console.log("[3-append] unowned pre-existing thread after a refused call:", claimed);
  expect(claimed.agent_id).toBe("Z");
});

test("3: a refused forget writes nothing", async () => {
  const vm = await userMemory({
    threadId: "t3",
    sentence: "My billing email is vault@example.com.",
    scopeType: "vault",
    scopeId: null,
    memoryKey: "user.billing_email",
  });
  const before = (await db.query("SELECT count(*)::int AS n FROM memory_revisions")).rows[0]
    .n as number;
  await expect(
    tool("forget", { scope: "vault", memory_id: vm.id, reason: ["bad"] }),
  ).rejects.toThrow(/must be a string/);
  expect((await getMemory(db, vm.id))?.status).toBe("committed");
  expect(
    (await db.query("SELECT count(*)::int AS n FROM memory_revisions")).rows[0].n as number,
  ).toBe(before);
});

test("3: survivors of the argument-reader claim", async () => {
  // structured_value is read with a bare cast.
  const r = await tool("remember", {
    scope: "vault",
    content: "the office is in Berlin",
    structured_value: "not an object",
  });
  // eslint-disable-next-line no-console
  console.log("[3-survivor] remember(structured_value:'string') ->", r);
  const p = await runProjections(db, store, 20);
  // eslint-disable-next-line no-console
  console.log("[3-survivor] projections:", p.projected, p.failed, p.results);
  const m = await getMemory(db, String(r.memory_id));
  // eslint-disable-next-line no-console
  console.log("[3-survivor] stored structured_value:", JSON.stringify(m?.structured_value));
  // The claim under test: no caller-supplied argument reaches a durable column
  // unvalidated. If this fails, structured_value is a survivor.
  expect(typeof m?.structured_value).toBe("object");
});

test("3: list_events reads from_sequence/limit with a bare cast", async () => {
  await say("t1", "hello");
  const out = await tool("list_events", { thread_id: "t1", from_sequence: {}, limit: "5" }).catch(
    (e) => ({ error: String(e) }),
  );
  // eslint-disable-next-line no-console
  console.log("[3-survivor] list_events(from_sequence:{}) ->", JSON.stringify(out).slice(0, 200));
  expect(out).toBeDefined();
});

// ---------------------------------------------------------------------------
// 4. enrichMemory's screen
// ---------------------------------------------------------------------------

test("4: enrich refuses a credential in ANY container", async () => {
  const { writeMemory } = await import("../src/server/memory/items.js");
  const u = await say("t1", "hello");
  const m = must(
    (
      await writeMemory(db, {
        scopeType: "vault",
        scopeId: null,
        memoryType: "semantic",
        memoryKey: null,
        content: "the deploy runbook",
        sourceEventIds: [u.id],
        explicit: true,
        createdBy: "extractor:probe",
      })
    ).memory,
    "memory",
  );
  for (const payload of [
    { api_key: "hunter2swordfish" },
    { api_key: ["hunter2swordfish"] },
    { api_key: { v: "hunter2swordfish" } },
    { nested: [{ password: "correct-horse-battery" }] },
  ]) {
    await expect(
      enrichMemory(db, { memoryId: m.id, structuredValue: payload, actor: "admin:probe" }),
    ).rejects.toThrow(/credentials are never stored/);
  }
  expect(Object.keys(must(await getMemory(db, m.id), "row").structured_value)).toEqual([]);
});

// ---------------------------------------------------------------------------
// 5. events: the actor table and append_event's enum
// ---------------------------------------------------------------------------

test("5: the enum and the guard agree on exactly the same set", async () => {
  const { IMPLIED_ACTOR } = await import("../src/server/memory/events.js");
  const all = Object.keys(IMPLIED_ACTOR);
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const t of [...all, "constructor", "__proto__", "toString", "valueOf", ""]) {
    await ensureThread(db, "t1");
    try {
      await tool("append_event", { thread_id: "t1", event_type: t, content: "x" });
      accepted.push(t);
    } catch {
      refused.push(t);
    }
  }
  // eslint-disable-next-line no-console
  console.log("[5] accepted:", accepted, "refused:", refused);
  expect(accepted.sort()).toEqual(
    all.filter((t) => IMPLIED_ACTOR[t as keyof typeof IMPLIED_ACTOR] !== "user").sort(),
  );
  // Nothing that speaks for the user landed.
  const users = await db.query(
    "SELECT count(*)::int AS n FROM conversation_events WHERE actor_type = 'user'",
  );
  expect(users.rows[0].n).toBe(0);
  // And every stored row has an actor_type the table defines.
  const bad = await db.query(
    "SELECT count(*)::int AS n FROM conversation_events WHERE actor_type IS NULL",
  );
  expect(bad.rows[0].n).toBe(0);
});

// ---------------------------------------------------------------------------
// 6. referentsFor — the mirror
// ---------------------------------------------------------------------------

test("6-mirror: ambiguous refused, out-of-scope untouched, legitimate lands", async () => {
  // Two same-shaped keyed facts in one thread -> ambiguous.
  await userMemory({
    threadId: "t1",
    sentence: "My billing email is real@example.com.",
    scopeType: "thread",
    scopeId: "t1",
    memoryKey: "user.billing_email",
  });
  const work = await userMemory({
    threadId: "t1",
    sentence: "My work email is work@example.com.",
    scopeType: "thread",
    scopeId: "t1",
    memoryKey: "user.work_email",
  });
  await say("t1", "actually it is other@example.com");
  await runExtraction(db, deterministicExtractor, {
    threadId: "t1",
    allowedScopes: [{ scopeType: "thread", scopeId: "t1" }],
  });
  expect(
    must(
      await getActiveByKey(db, {
        scopeType: "thread",
        scopeId: "t1",
        memoryType: "semantic",
        memoryKey: "user.billing_email",
      }),
      "billing",
    ).content,
  ).toContain("real@example.com");
  expect((await getMemory(db, work.id))?.status).toBe("committed");

  // Out-of-scope referent: a vault fact is not corrected from a thread.
  const vault = await userMemory({
    threadId: "t9",
    sentence: "My shipping address is 1 Main St.",
    scopeType: "vault",
    scopeId: null,
    memoryKey: "user.shipping_address",
  });
  await say("t8", "actually it is 2 Side Rd");
  await runExtraction(db, deterministicExtractor, {
    threadId: "t8",
    allowedScopes: [{ scopeType: "thread", scopeId: "t8" }],
  });
  expect((await getMemory(db, vault.id))?.status).toBe("committed");

  // Legitimate correction still lands: one referent in scope.
  const only = await userMemory({
    threadId: "t5",
    sentence: "My billing email is first@example.com.",
    scopeType: "thread",
    scopeId: "t5",
    memoryKey: "user.billing_email",
  });
  await say("t5", "actually it is second@example.com");
  await runExtraction(db, deterministicExtractor, {
    threadId: "t5",
    allowedScopes: [{ scopeType: "thread", scopeId: "t5" }],
  });
  expect((await getMemory(db, only.id))?.status).toBe("superseded");
  expect(
    must(
      await getActiveByKey(db, {
        scopeType: "thread",
        scopeId: "t5",
        memoryType: "semantic",
        memoryKey: "user.billing_email",
      }),
      "corrected",
    ).content,
  ).toContain("second@example.com");
});
