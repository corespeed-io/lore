import {
  compareEpisodeEvidenceCandidates,
  createDeterministicTestEmbeddingProvider,
  type EpisodeEvidenceCandidateQuery,
  episodeEvidenceCandidatesStatement,
} from "@corespeed/lore-core/testing";
import { expect, test } from "vitest";
import { createEpisodeEvidenceModule } from "@/modules/episodes/evidence";
import { createObservationModule } from "@/modules/episodes/service";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage } from "@/server/database/memory-storage";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

// Migration 0022 moved the channels of Episode evidence search into
// lore.episode_evidence_candidates, a SECURITY DEFINER function, so that 0023's
// indexes can serve its lexical probes and its semantic channel computes each
// distance in the scan. That is a pure speed-up only if the function answers exactly
// what the channels answered under RLS, for every kind of caller, and if nothing it
// answers can reach a caller that RLS would not show it.

const RESEARCH_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const provider = createDeterministicTestEmbeddingProvider(1024);

async function seedCorpus(context: MemoryTestContext) {
  const observations = createObservationModule(context.database);
  const evidence = createEpisodeEvidenceModule(context.database, { embeddingProvider: provider });
  const seeds: [ActorContext, "shared" | "private", string[]][] = [
    [
      context.alice,
      "shared",
      ["Staging deploys run from the prod branch.", "Retry budget is two."],
    ],
    [context.alice, "private", ["Alice's private staging retry budget note."]],
    [
      context.alice,
      "shared",
      // Decomposed kana: NFC composes か + U+3099 into が, which a query gram can match.
      [
        "データベースのバックアップが日曜に実行されます。",
        "テストか\u3099終わりました。",
        // Only NFC turns this into the gram がく: unnormalized, no query gram matches.
        "か\u3099く",
      ],
    ],
    [context.bob, "shared", ["Bob shares that staging deploys use the Omega queue."]],
    [
      context.bob,
      "private",
      ["Bob's private staging retry budget is three.", "记忆召回质量审计。"],
    ],
    [context.carol, "shared", ["Research stages deploys with the same retry budget."]],
    // Equal content: equal vectors and equal text ranks, so the order falls to the
    // tie-breakers.
    [context.alice, "shared", ["Kestrel ships on Friday.", "Kestrel ships on Friday."]],
  ];
  for (const [index, [actor, scope, contents]] of seeds.entries()) {
    const episode = await observations.record(actor, {
      kind: "conversation",
      scope,
      observations: contents.map((content) => ({
        kind: "message" as const,
        content,
        metadata: { session: `s${index % 3}`, kind: index % 2 ? "odd" : "even" },
      })),
    });
    await evidence.index(actor, { episodeId: episode.id });
  }
}

async function queries(): Promise<EpisodeEvidenceCandidateQuery[]> {
  const texts = [
    "staging retry budget",
    "Kestrel ships on Friday",
    "データベースのバックアップ",
    "テストが",
    "がく",
    "记忆召回",
    "nothing alike at all",
  ];
  const vectors = await provider.embed(texts, "query");
  return texts.flatMap((query, index) => {
    const base: EpisodeEvidenceCandidateQuery = {
      query,
      queryEmbedding: vectors[index] ?? null,
      embeddingProvider: provider,
      embeddingDimensions: 1024,
      distanceThreshold: 2,
      candidateLimit: 40,
    };
    return [
      base,
      { ...base, queryEmbedding: null },
      { ...base, candidateLimit: 1 },
      { ...base, distanceThreshold: 0.2 },
      { ...base, scope: "private" as const },
      { ...base, metadataFilter: { kind: "odd" } },
      { ...base, groupMetadataKey: "session", sourceKeys: ["s0", "s2"] },
      { ...base, groupMetadataKey: "session", sourceKeys: [] },
      { ...base, embeddingProvider: { ...provider, revision: "another-revision" } },
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

test("the function answers the RLS channels for Users, Agents, ties, and revoked access", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const asked = await queries();
  const aliceAgent = await readerAgent(context, context.alice);
  const bobAgent = await readerAgent(context, context.bob);

  const channels = new Set<string>();
  let found = 0;
  let cjkOnlyByNormalization = 0;
  for (const actor of [
    context.alice,
    context.bob,
    context.carol,
    aliceAgent.actor,
    bobAgent.actor,
  ]) {
    const storage = createMemoryStorage(context.database, actor);
    for (const { query, host, reference } of await compareEpisodeEvidenceCandidates(
      storage,
      asked,
    )) {
      const label = `${actor.userId}/${actor.agentId ?? "human"} ${JSON.stringify({
        ...query,
        queryEmbedding: undefined,
      })}`;
      expect(host, label).toEqual(reference);
      found += reference.length;
      for (const line of reference) channels.add(line.split(" ", 1)[0] ?? "");
      if (query.query === "がく" && reference.some((line) => line.startsWith("cjk "))) {
        cjkOnlyByNormalization += 1;
      }
    }
  }
  expect(found).toBeGreaterThan(300);
  expect([...channels].sort()).toEqual(["cjk", "english", "semantic", "simple"]);
  expect(cjkOnlyByNormalization).toBeGreaterThan(0);

  // A revoked grant and a suspended Membership see nothing either way.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE agent_workspace_grants SET status = 'revoked' WHERE agent_id = $1", [
      aliceAgent.agentId,
    ]),
  );
  await context.suspendMembership(context.bob);
  for (const actor of [aliceAgent.actor, context.bob]) {
    const storage = createMemoryStorage(context.database, actor);
    for (const { host, reference } of await compareEpisodeEvidenceCandidates(storage, asked)) {
      expect(reference).toEqual([]);
      expect(host).toEqual([]);
    }
  }
});

test("the semantic channel stays exact when the planner would rather use the HNSW index", async () => {
  // With sequential scans and sorts priced out and hnsw.ef_search at 1, an ORDER BY
  // the HNSW index could serve would answer about one row before the filters.
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const asked = (await queries()).filter(
    (query) => query.candidateLimit === 40 && query.queryEmbedding && !query.scope,
  );
  const storage = createMemoryStorage(context.database, context.alice);
  const answers = await storage.database.transaction(async (transaction) => {
    await transaction.query("SET LOCAL enable_seqscan = off");
    await transaction.query("SET LOCAL enable_sort = off");
    await transaction.query("SET LOCAL hnsw.ef_search = 1");
    return transaction.batch(
      asked.map((query) => episodeEvidenceCandidatesStatement(context.alice.workspaceId, query)),
    );
  });
  const reference = await compareEpisodeEvidenceCandidates(storage, asked);
  for (const [index, answer] of answers.entries()) {
    const lines = answer.rows.map(
      (row) =>
        `${row.channel} ${Number(row.candidate_rank)} ${row.chunk_id} ${row.episode_id} ${row.observation_id}`,
    );
    expect(lines).toEqual(reference[index]?.reference);
  }
  expect(
    answers.some((answer) => answer.rows.filter((row) => row.channel === "semantic").length > 3),
  ).toBe(true);
});

test("the function fails closed: another Workspace's id, or no Actor, answers nothing", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const [query] = await queries();
  if (!query) throw new Error("Expected a query");
  const run = (actor: ActorContext | null, partitionId: string) =>
    context.database.transaction(async (transaction) => {
      if (actor) installActorContext(transaction, actor);
      const [answer] = await transaction.batch([
        episodeEvidenceCandidatesStatement(partitionId, query),
      ]);
      return answer.rows;
    });

  expect(await run(context.alice, context.alice.workspaceId)).not.toEqual([]);
  expect(await run(context.carol, RESEARCH_WORKSPACE_ID)).not.toEqual([]);
  expect(await run(context.alice, RESEARCH_WORKSPACE_ID)).toEqual([]);
  expect(await run(null, context.alice.workspaceId)).toEqual([]);
});

test("a caller's temporary relations cannot stand in for the tables the definer function reads", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const [query] = await queries();
  if (!query) throw new Error("Expected a query");
  const answer = (shadow: "none" | "tables" | "views") =>
    context.database.transaction(async (transaction) => {
      installActorContext(transaction, context.alice);
      if (shadow === "tables") {
        for (const table of ["episodes", "observations", "episode_evidence_chunks"]) {
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
          `CREATE TEMP VIEW episodes AS
           SELECT episode.*, pg_temp.tripwire(episode.id::text) AS tripped
           FROM public.episodes episode`,
        );
        await transaction.query(
          `CREATE TEMP VIEW observations AS
           SELECT observation.*, pg_temp.tripwire(observation.content) AS tripped
           FROM public.observations observation`,
        );
      }
      const [rows] = await transaction.batch([
        episodeEvidenceCandidatesStatement(context.alice.workspaceId, query),
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
       WHERE pronamespace = 'lore'::regnamespace AND proname = 'episode_evidence_candidates'`,
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
  const [query] = await queries();
  if (!query) throw new Error("Expected a query");
  await expect(
    context.maintenanceDatabase.transaction((transaction) =>
      transaction.batch([episodeEvidenceCandidatesStatement(context.alice.workspaceId, query)]),
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
      `CREATE OR REPLACE FUNCTION lore.episode_evidence_candidates(
         target_workspace_id uuid, search_query text, cjk_query_grams text[],
         query_embedding vector, embedding_provider text, embedding_model text,
         embedding_revision text, embedding_dimensions integer,
         distance_threshold double precision, index_revision text, scope_filter memory_scope,
         metadata_filter jsonb, group_metadata_key text, source_keys text[],
         candidate_limit integer)
       RETURNS TABLE(channel text, chunk_id uuid, episode_id uuid, observation_id uuid,
         candidate_rank bigint)
       LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
       AS $$ SELECT 'simple', chunk.id, chunk.episode_id, chunk.observation_id, 1::bigint
             FROM episode_evidence_chunks chunk $$`,
    ),
  );
  const hidden = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string }>(
      `SELECT observation.id FROM observations observation
       JOIN episodes episode ON episode.id = observation.episode_id
       WHERE episode.workspace_id <> $1 OR (episode.scope = 'private' AND episode.owner_user_id <> $2)`,
      [context.alice.workspaceId, context.alice.userId],
    );
    return result.rows.map((row) => row.id);
  });
  expect(hidden.length).toBeGreaterThan(2);

  const results = await createEpisodeEvidenceModule(context.database).search(context.alice, {
    query: "an unrelated question",
    limit: 50,
  });
  const seen = new Set(results.flatMap((result) => result.observationIds));
  expect(seen.size).toBeGreaterThan(0);
  for (const id of hidden) expect(seen.has(id)).toBe(false);
});

test("each lexical probe uses its Workspace-leading index as the function's owner", async () => {
  const context = await createMemoryTestContext();
  // Enough unrelated chunks in the Workspace that a selective probe beats reading
  // the Workspace's rows through its btree.
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query("SET LOCAL session_replication_role = replica");
    await transaction.query(
      `INSERT INTO episode_evidence_chunks (workspace_id, episode_id, observation_id,
         observation_ordinal, chunk_ordinal, content, index_revision)
       SELECT $1, gen_random_uuid(), gen_random_uuid(), 0, 0,
         'filler note ' || n || ' 填充内容第' || n || '条', 'filler'
       FROM generate_series(1, 3000) AS n`,
      [context.alice.workspaceId],
    );
    await transaction.query("ANALYZE episode_evidence_chunks");
  });
  const probes = [
    [
      "episode_evidence_chunks_workspace_search_idx",
      "candidate.search_vector @@ websearch_to_tsquery('simple', 'staging retry')",
    ],
    [
      "episode_evidence_chunks_workspace_search_english_idx",
      "candidate.search_vector_english @@ websearch_to_tsquery('english', 'deploys')",
    ],
    [
      "episode_evidence_chunks_workspace_cjk_grams_idx",
      "lore.extract_cjk_grams(normalize(candidate.content, NFC)) && ARRAY['召回质']",
    ],
  ] as const;
  for (const [index, condition] of probes) {
    const plan = await context.adminDatabase.transaction(async (transaction) => {
      await transaction.query("SET LOCAL enable_seqscan = off");
      const result = await transaction.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT candidate.id FROM episode_evidence_chunks candidate
         WHERE candidate.workspace_id = '${context.alice.workspaceId}'::uuid AND ${condition}`,
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan, index).toMatch(new RegExp(`Bitmap Index Scan on ${index}\\b`));
  }
});
