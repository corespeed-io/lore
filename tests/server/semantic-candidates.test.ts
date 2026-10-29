import { createEmbeddingMaintenance } from "@corespeed/lore-core";
import {
  compareSemanticCandidates,
  createDeterministicTestEmbeddingProvider,
  type SemanticCandidateQuery,
  semanticCandidatesStatement,
} from "@corespeed/lore-core/testing";
import { expect, test } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage } from "@/server/database/memory-storage";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

// Migration 0020 moved the semantic channel into lore.semantic_candidates, a SECURITY
// DEFINER function, so that it checks visibility once for each Memory rather than
// through the policies of every embedded chunk. That is a pure speed-up only if the
// function answers exactly what the channel answered under RLS, for every kind of
// caller, and if nothing it answers can reach a caller that RLS would not show it.

const RESEARCH_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const provider = createDeterministicTestEmbeddingProvider(1024);

async function seedCorpus(context: MemoryTestContext) {
  const memories = createMemoryModule(context.database, { embeddingProvider: provider });
  const seeds: [ActorContext, string, "shared" | "private", Record<string, unknown>?][] = [
    [context.alice, "Staging deploys run from the prod branch.", "shared", { kind: "decision" }],
    [context.alice, "The staging deploy retry budget is two attempts.", "private"],
    [context.alice, "Tidal navigation charts live in the harbor office.", "shared"],
    [context.alice, `Deploy checklist.\n\n${"Retry budgets and rollbacks. ".repeat(80)}`, "shared"],
    // Equal content embeds to equal vectors: with equal updated_at below, these
    // tie on distance and recency, so the order falls to ordinal and chunk id.
    [context.alice, "Kestrel ships on Friday.", "shared"],
    [context.bob, "Kestrel ships on Friday.", "shared"],
    [context.bob, "Kestrel ships on Friday.", "private"],
    [context.bob, "Bob's private staging retry budget is three.", "private"],
    [context.bob, "Bob shares that deploys go through the Omega queue.", "shared"],
    [context.carol, "Research stages deploys with the same retry budget.", "shared"],
  ];
  const ids: string[] = [];
  for (const [actor, content, scope, metadata] of seeds) {
    const memory = await memories.remember(actor, {
      content,
      scope,
      ...(metadata ? { metadata } : {}),
    });
    ids.push(memory.id);
  }
  await context.adminDatabase.transaction(async (transaction) => {
    for (const [index, id] of ids.entries()) {
      const day = index >= 4 && index <= 6 ? 30 : 1 + index;
      await transaction.query("UPDATE memories SET updated_at = $2::timestamptz WHERE id = $1", [
        id,
        `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`,
      ]);
    }
  });
  const maintenance = createEmbeddingMaintenance(context.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  while ((await maintenance.run()).status === "complete") {
    // Embed every Memory.
  }
  return ids;
}

async function queries(ids: readonly string[]): Promise<SemanticCandidateQuery[]> {
  const vectors = await provider.embed(
    ["Kestrel ships on Friday.", "staging retry budget", "tidal harbor charts"],
    "query",
  );
  return vectors.flatMap((queryEmbedding) => {
    const base = {
      queryEmbedding,
      embeddingProvider: provider,
      embeddingDimensions: 1024,
      distanceThreshold: 2,
      candidateLimit: 40,
    };
    return [
      base,
      { ...base, candidateLimit: 1 },
      { ...base, candidateLimit: 2 },
      { ...base, distanceThreshold: 0.2 },
      { ...base, scope: "private" as const },
      { ...base, metadataFilter: { kind: "decision" } },
      { ...base, excludedMemoryIds: ids.slice(4, 6) },
      { ...base, updatedAfter: "2026-09-03T00:00:00Z", updatedBefore: "2026-09-30T00:00:00Z" },
    ];
  });
}

async function readerAgent(context: MemoryTestContext, owner: ActorContext) {
  const access = createAccessModule(context.database);
  const agent = await access.createAgentForWorkspace(owner, {
    name: `${owner.userId} reader`,
    permission: "read",
  });
  const credential = await access.issueAgentCredential(owner, agent.id);
  const actor = await access.authenticateAgent(credential.token, owner.workspaceId);
  if (!actor) throw new Error("Expected the reader Agent to authenticate");
  return { agentId: agent.id, actor };
}

test("the function answers the RLS channel for Users, Agents, ties, and revoked access", async () => {
  const context = await createMemoryTestContext();
  const ids = await seedCorpus(context);
  const asked = await queries(ids);
  const aliceAgent = await readerAgent(context, context.alice);
  const bobAgent = await readerAgent(context, context.bob);

  let found = 0;
  for (const actor of [
    context.alice,
    context.bob,
    context.carol,
    aliceAgent.actor,
    bobAgent.actor,
  ]) {
    const storage = createMemoryStorage(context.database, actor);
    for (const { query, host, reference } of await compareSemanticCandidates(storage, asked)) {
      const label = `${actor.userId}/${actor.agentId ?? "human"} ${JSON.stringify({
        ...query,
        queryEmbedding: undefined,
      })}`;
      expect(host, label).toEqual(reference);
      found += reference.length;
    }
  }
  expect(found).toBeGreaterThan(150);

  // A revoked grant and a suspended Membership see nothing either way.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE agent_workspace_grants SET status = 'revoked' WHERE agent_id = $1", [
      aliceAgent.agentId,
    ]),
  );
  await context.suspendMembership(context.bob);
  for (const actor of [aliceAgent.actor, context.bob]) {
    const storage = createMemoryStorage(context.database, actor);
    for (const { host, reference } of await compareSemanticCandidates(storage, asked)) {
      expect(reference).toEqual([]);
      expect(host).toEqual([]);
    }
  }
});

test("the function stays exact when the planner would rather use the HNSW index", async () => {
  // With sequential scans and sorts priced out and hnsw.ef_search at 1, an ORDER BY
  // the HNSW index could serve would answer about one row before the filters. The function
  // must never let it, or the channel would silently drop candidates.
  const context = await createMemoryTestContext();
  const ids = await seedCorpus(context);
  const asked = (await queries(ids)).filter((query) => query.candidateLimit === 40);
  const storage = createMemoryStorage(context.database, context.alice);
  const answers = await storage.database.transaction(async (transaction) => {
    await transaction.query("SET LOCAL enable_seqscan = off");
    await transaction.query("SET LOCAL enable_sort = off");
    await transaction.query("SET LOCAL hnsw.ef_search = 1");
    return transaction.batch(
      asked.map((query) => semanticCandidatesStatement(context.alice.workspaceId, query)),
    );
  });
  const reference = await compareSemanticCandidates(storage, asked);
  for (const [index, answer] of answers.entries()) {
    const lines = answer.rows.map(
      (row) => `${Number(row.candidate_rank)} ${row.chunk_id} ${row.memory_id}`,
    );
    expect(lines).toEqual(reference[index]?.reference);
  }
  expect(answers.some((answer) => answer.rows.length > 3)).toBe(true);
});

test("the function fails closed: another Workspace's id, or no Actor, answers nothing", async () => {
  const context = await createMemoryTestContext();
  const ids = await seedCorpus(context);
  const [query] = await queries(ids);
  if (!query) throw new Error("Expected a query");
  const run = (actor: ActorContext | null, partitionId: string) =>
    context.database.transaction(async (transaction) => {
      if (actor) installActorContext(transaction, actor);
      const [answer] = await transaction.batch([semanticCandidatesStatement(partitionId, query)]);
      return answer.rows;
    });

  expect(await run(context.alice, context.alice.workspaceId)).not.toEqual([]);
  expect(await run(context.carol, RESEARCH_WORKSPACE_ID)).not.toEqual([]);
  expect(await run(context.alice, RESEARCH_WORKSPACE_ID)).toEqual([]);
  expect(await run(null, context.alice.workspaceId)).toEqual([]);
});

test("a caller's temporary relations cannot stand in for the tables the definer function reads", async () => {
  const context = await createMemoryTestContext();
  const ids = await seedCorpus(context);
  const [query] = await queries(ids);
  if (!query) throw new Error("Expected a query");
  const answer = (shadow: "none" | "tables" | "views") =>
    context.database.transaction(async (transaction) => {
      installActorContext(transaction, context.alice);
      if (shadow === "tables") {
        for (const table of ["memories", "memory_chunks", "memory_chunk_embeddings"]) {
          await transaction.query(
            `CREATE TEMP TABLE ${table} (LIKE public.${table}) ON COMMIT DROP`,
          );
        }
      }
      if (shadow === "views") {
        await transaction.query(
          `CREATE FUNCTION pg_temp.tripwire(text) RETURNS text LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'a temporary relation was read: %', $1; END $$`,
        );
        await transaction.query(
          `CREATE TEMP VIEW memory_chunk_embeddings AS
           SELECT embedded.*, pg_temp.tripwire(embedded.chunk_id::text) AS tripped
           FROM public.memory_chunk_embeddings embedded`,
        );
        await transaction.query(
          `CREATE TEMP VIEW memories AS
           SELECT memory.*, pg_temp.tripwire(memory.content) AS tripped FROM public.memories memory`,
        );
      }
      const [rows] = await transaction.batch([
        semanticCandidatesStatement(context.alice.workspaceId, query),
      ]);
      return rows.rows;
    });
  const expected = await answer("none");
  expect(expected.length).toBeGreaterThan(0);
  expect(await answer("tables")).toEqual(expected);
  expect(await answer("views")).toEqual(expected);
});

test("only lore_app may execute the definer function, and it pins search_path", async () => {
  const context = await createMemoryTestContext();
  const functions = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{
      definer: boolean;
      volatility: string;
      config: string[];
    }>(
      `SELECT prosecdef AS definer, provolatile AS volatility, coalesce(proconfig, '{}') AS config
       FROM pg_proc
       WHERE pronamespace = 'lore'::regnamespace AND proname = 'semantic_candidates'`,
    );
    return result.rows;
  });
  expect(functions).toEqual([
    {
      definer: true,
      volatility: "s",
      config: ["search_path=pg_catalog, public, pg_temp", "plan_cache_mode=force_custom_plan"],
    },
  ]);
  const [query] = await queries([]);
  if (!query) throw new Error("Expected a query");
  await expect(
    context.maintenanceDatabase.transaction((transaction) =>
      transaction.batch([semanticCandidatesStatement(context.alice.workspaceId, query)]),
    ),
  ).rejects.toThrow(/permission denied/);
});

test("search reads every candidate back under RLS, so an over-answering function reveals nothing", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  // Stand-in for a broken definer function: every chunk in the database, from every
  // Workspace and owner, ranked first.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `CREATE OR REPLACE FUNCTION lore.semantic_candidates(
         target_workspace_id uuid, query_embedding vector, embedding_provider text,
         embedding_model text, embedding_revision text, embedding_dimensions integer,
         distance_threshold double precision, scope_filter memory_scope,
         updated_after timestamptz, updated_before timestamptz, metadata_filter jsonb,
         excluded_memory_ids uuid[], candidate_limit integer)
       RETURNS TABLE(chunk_id uuid, memory_id uuid, candidate_rank bigint)
       LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
       AS $$ SELECT chunk.id, chunk.memory_id, 1::bigint FROM memory_chunks chunk $$`,
    ),
  );
  const hidden = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      `SELECT id FROM memories
       WHERE workspace_id <> $1 OR (scope = 'private' AND owner_user_id <> $2)`,
      [context.alice.workspaceId, context.alice.userId],
    );
    return result.rows.map((row) => row.id);
  });
  expect(hidden.length).toBeGreaterThan(2);

  const results = await createMemoryModule(context.database, {
    embeddingProvider: provider,
  }).search(context.alice, { query: "an unrelated question", limit: 100 });
  const seen = new Set(results.map((result) => result.memory.id));
  expect(seen.size).toBeGreaterThan(0);
  for (const id of hidden) expect(seen.has(id)).toBe(false);
});
