import {
  cjkLexicalGrams,
  compareLexicalCandidates,
  type LexicalCandidateQuery,
  lexicalCandidatesStatement,
} from "@corespeed/lore-core/testing";
import { expect, test } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import { createMemoryStorage } from "@/server/database/memory-storage";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

// Migration 0012 moved the lexical channels into lore.lexical_candidates, a SECURITY
// DEFINER function, so that 0013's indexes can serve them: under RLS no index can
// serve `@@`, `@>`, or LIKE. That is a pure speed-up only if the function answers
// exactly what the channels answered under RLS, for every kind of caller, and if
// nothing it answers can reach a caller that RLS would not show it. The engine's
// contract suite compares the channels for two human Users; this file adds Agents,
// revoked access, failing closed, the grant, the RLS read-back, the CJK index terms,
// and the plans. Revision 15 added name channels over titles and English glosses; the
// corpus names some Memories so every comparison covers them too.

const RESEARCH_WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";

async function seedCorpus(context: MemoryTestContext) {
  const memories = createMemoryModule(context.database);
  const long = (lead: string) =>
    `${lead}\n\n${"Background on the rollout and its retry budget. ".repeat(40)}\n\nKestrel owns the follow-up.`;
  const seeds: [
    ActorContext,
    string,
    "shared" | "private",
    Record<string, unknown>?,
    string?,
    string?,
  ][] = [
    [
      context.alice,
      "Staging deploys run from the prod branch, not main.",
      "shared",
      { kind: "decision" },
    ],
    [context.alice, "The staging deploy retry budget is two attempts.", "private"],
    [context.alice, "Project Kestrel ships the Hyperdrive pooling change on Friday.", "shared"],
    [context.alice, "Kestrel and Omega share one retry budget for staging deploys.", "shared"],
    [context.alice, long("Deploy checklist for staging and prod."), "shared"],
    [context.alice, "生产环境的记忆召回质量在八月的专项审计中被评为需要重点改进。", "shared"],
    [context.alice, "记忆召回质量审计的结论由杭州团队提交给财务系统。", "private"],
    [context.alice, "ユーザーデータベースの週次バックアップは日曜深夜に実行されます。", "shared"],
    [context.bob, "Bob's private note: the staging retry budget is secretly three.", "private"],
    [context.bob, "Bob shares that Kestrel deploys go through the Omega queue.", "shared"],
    [context.bob, "鲍勃的私人记录：记忆召回质量审计的真实结论是完全达标。", "private"],
    [context.bob, long("Bob's staging deploy runbook."), "private"],
    [
      context.alice,
      "HAAS-62 rewrote the semantic channel; O'Brien's Kestrel budget review followed.",
      "shared",
    ],
    [context.bob, "O'Brien's staging deploys reuse the HAAS-62 retry budget.", "shared"],
    [context.carol, "Research stages deploys with the same retry budget as Kestrel.", "shared"],
    [context.carol, "研究团队的记忆召回质量审计结论。", "shared"],
    // Titled Memories whose content shares no word with their title, so only the title
    // channels can find them by it.
    [context.alice, "Pools open per request.", "shared", undefined, "Hyperdrive pooling rollout"],
    [context.alice, "Two attempts, then page.", "private", undefined, "Staging retry escalation"],
    [context.alice, "周日深夜执行。", "shared", undefined, "数据库每周备份计划"],
    [context.bob, "Only Bob reads this.", "private", undefined, "Bob's Hyperdrive pooling secrets"],
    [context.bob, "鲍勃自己的。", "private", undefined, "数据库备份的私人笔记"],
    [context.carol, "Research note.", "shared", undefined, "Hyperdrive pooling in Research"],
    // Glossed Memories: content in another language, found in English by the gloss.
    [
      context.alice,
      "部署失败后先回滚，再排查。",
      "shared",
      undefined,
      undefined,
      "Roll back a failed deploy first, then investigate",
    ],
    [
      context.bob,
      "鲍勃的回滚笔记。",
      "private",
      undefined,
      "回滚",
      "Bob's private rollback notes for failed deploys",
    ],
  ];
  const ids: string[] = [];
  for (const [actor, content, scope, metadata, title, gloss] of seeds) {
    const memory = await memories.remember(actor, {
      content,
      scope,
      ...(metadata ? { metadata } : {}),
      ...(title ? { title } : {}),
      ...(gloss ? { gloss } : {}),
    });
    ids.push(memory.id);
  }
  // Spread updated_at so ties break on it, as they do in a real Workspace.
  await context.adminDatabase.transaction(async (transaction) => {
    for (const [index, id] of ids.entries()) {
      await transaction.query("UPDATE memories SET updated_at = $2::timestamptz WHERE id = $1", [
        id,
        `2026-09-${String(1 + (index % 20)).padStart(2, "0")}T00:00:00Z`,
      ]);
    }
  });
  return ids;
}

const QUERIES = [
  "staging deploy",
  "what is the retry budget for staging deploys",
  "Kestrel Omega retry",
  "Project Kestrel Hyperdrive",
  '"retry budget" -prod',
  "记忆召回质量的审计结论是什么？",
  "召回质量",
  "データベースのバックアップ",
  // A hyphenated identifier is several lexemes, an apostrophe must survive the tsquery
  // text round trip, and many terms make many pairs.
  "HAAS-62 semantic budget",
  "O'Brien's Kestrel budget",
  "Kestrel Hyperdrive Omega staging retry budget deploys checklist prod branch Friday",
  // Name channels: a title alone, a question about one, a CJK one, and English
  // queries that only a gloss answers.
  "Hyperdrive pooling",
  "how do we escalate a staging retry",
  "数据库备份",
  "rollback",
  "what do we do after a failed deploy",
];

function variants(query: string): LexicalCandidateQuery[] {
  return [
    { query, candidateLimit: 40, entityAliasRecall: true },
    { query, candidateLimit: 1, entityAliasRecall: true },
    { query, candidateLimit: 40, entityAliasRecall: true, scope: "private" },
    {
      query,
      candidateLimit: 40,
      entityAliasRecall: true,
      updatedAfter: "2026-09-04T00:00:00Z",
      updatedBefore: "2026-09-10T00:00:00Z",
    },
  ];
}

async function compareFor(context: MemoryTestContext, actor: ActorContext) {
  return compareLexicalCandidates(
    createMemoryStorage(context.database, actor),
    QUERIES.flatMap(variants),
  );
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

test("the function answers the RLS channels for Users, Agents, and revoked access", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const aliceAgent = await readerAgent(context, context.alice);
  const bobAgent = await readerAgent(context, context.bob);

  let found = 0;
  const nameChannels = new Set<string>();
  for (const actor of [
    context.alice,
    context.bob,
    context.carol,
    aliceAgent.actor,
    bobAgent.actor,
  ]) {
    for (const { query, host, reference } of await compareFor(context, actor)) {
      expect(host, `${actor.userId}/${actor.agentId ?? "human"} ${JSON.stringify(query)}`).toEqual(
        reference,
      );
      found += reference.length;
      for (const line of reference) {
        const channel = line.split(" ", 1)[0] ?? "";
        if (channel.startsWith("name_")) nameChannels.add(channel);
      }
    }
  }
  expect(found).toBeGreaterThan(200);
  expect([...nameChannels].sort()).toEqual([
    "name_cjk",
    "name_english",
    "name_relaxed_english",
    "name_simple",
  ]);

  // A revoked grant and a suspended Membership see nothing either way.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE agent_workspace_grants SET status = 'revoked' WHERE agent_id = $1", [
      aliceAgent.agentId,
    ]),
  );
  await context.suspendMembership(context.bob);
  for (const actor of [aliceAgent.actor, context.bob]) {
    for (const { host, reference } of await compareFor(context, actor)) {
      expect(reference).toEqual([]);
      expect(host).toEqual([]);
    }
  }
});

test("the function fails closed: another Workspace's id, or no Actor, answers nothing", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const query: LexicalCandidateQuery = {
    query: "staging retry budget Kestrel",
    candidateLimit: 40,
    entityAliasRecall: true,
  };
  const run = (actor: ActorContext | null, partitionId: string) =>
    context.database.transaction(async (transaction) => {
      if (actor) installActorContext(transaction, actor);
      const [answer] = await transaction.batch([lexicalCandidatesStatement(partitionId, query)]);
      return answer.rows;
    });

  expect(await run(context.alice, context.alice.workspaceId)).not.toEqual([]);
  // Research has a match of its own, which Carol finds and Alice must not.
  expect(await run(context.carol, RESEARCH_WORKSPACE_ID)).not.toEqual([]);
  expect(await run(context.alice, RESEARCH_WORKSPACE_ID)).toEqual([]);
  expect(await run(null, context.alice.workspaceId)).toEqual([]);
});

test("a caller's temporary relations cannot stand in for the tables the definer function reads", async () => {
  // pg_temp is searched first for relations and types unless search_path lists it,
  // even inside a SECURITY DEFINER function. A temporary view there would run as the
  // definer, and a function it calls would execute with the definer's rights before
  // any RLS read-back, which is how a reviewer read another Workspace's private
  // content through an exception. The function lists pg_temp last and qualifies its
  // relations and types; here every look-alike either answers nothing or trips.
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const query: LexicalCandidateQuery = {
    query: "staging retry budget Kestrel",
    candidateLimit: 40,
    entityAliasRecall: true,
  };
  const answer = (shadow: "none" | "tables" | "views") =>
    context.database.transaction(async (transaction) => {
      installActorContext(transaction, context.alice);
      if (shadow === "tables") {
        await transaction.query("CREATE TEMP TABLE memories (LIKE public.memories) ON COMMIT DROP");
        await transaction.query(
          "CREATE TEMP TABLE memory_chunks (LIKE public.memory_chunks) ON COMMIT DROP",
        );
      }
      if (shadow === "views") {
        await transaction.query(
          `CREATE FUNCTION pg_temp.tripwire(text) RETURNS tsvector LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'a temporary relation was read: %', $1; END $$`,
        );
        await transaction.query(
          `CREATE TEMP VIEW memory_chunks AS
           SELECT chunk.id, chunk.workspace_id, chunk.memory_id, chunk.ordinal, chunk.content,
                  chunk.chunking_revision, pg_temp.tripwire(chunk.content) AS search_vector,
                  pg_temp.tripwire(chunk.content) AS search_vector_english, chunk.entity_aliases
           FROM public.memory_chunks chunk`,
        );
        await transaction.query(
          `CREATE TEMP VIEW memories AS
           SELECT memory.*, pg_temp.tripwire(memory.content) AS tripped FROM public.memories memory`,
        );
      }
      const [rows] = await transaction.batch([
        lexicalCandidatesStatement(context.alice.workspaceId, query),
      ]);
      return rows.rows;
    });
  const expected = await answer("none");
  expect(expected.length).toBeGreaterThan(0);
  expect(await answer("tables")).toEqual(expected);
  expect(await answer("views")).toEqual(expected);
});

test("only lore_app may execute the definer function, and both functions pin search_path", async () => {
  const context = await createMemoryTestContext();
  const functions = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{
      name: string;
      definer: boolean;
      volatility: string;
      config: string[];
    }>(
      `SELECT proname AS name, prosecdef AS definer, provolatile AS volatility,
              coalesce(proconfig, '{}') AS config
       FROM pg_proc
       WHERE pronamespace = 'lore'::regnamespace
         AND proname IN ('lexical_candidates', 'extract_cjk_grams')
       ORDER BY proname`,
    );
    return result.rows;
  });
  expect(functions).toEqual([
    {
      name: "extract_cjk_grams",
      definer: false,
      volatility: "i",
      config: ["search_path=pg_catalog, pg_temp"],
    },
    {
      name: "lexical_candidates",
      definer: true,
      volatility: "s",
      config: ["search_path=pg_catalog, public, pg_temp", "plan_cache_mode=force_custom_plan"],
    },
  ]);
  await expect(
    context.maintenanceDatabase.transaction((transaction) =>
      transaction.batch([
        lexicalCandidatesStatement(context.alice.workspaceId, { query: "q", candidateLimit: 1 }),
      ]),
    ),
  ).rejects.toThrow(/permission denied/);
});

test("search reads every candidate back under RLS, so an over-answering function reveals nothing", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  // Stand-in for a broken definer function: every chunk in the database, from every
  // Workspace and owner, ranked first in every channel.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query(
      `CREATE OR REPLACE FUNCTION lore.lexical_candidates(
         target_workspace_id uuid, search_query text, relaxed_terms text[],
         cjk_query_grams text[], alias_limit integer, scope_filter memory_scope,
         updated_after timestamptz, updated_before timestamptz, metadata_filter jsonb,
         excluded_memory_ids uuid[], candidate_limit integer)
       RETURNS TABLE(channel text, chunk_id uuid, memory_id uuid, candidate_rank bigint)
       LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
       AS $$ SELECT 'simple', chunk.id, chunk.memory_id, 1::bigint FROM memory_chunks chunk $$`,
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
  expect(hidden.length).toBeGreaterThan(3);

  const results = await createMemoryModule(context.database).search(context.alice, {
    query: "staging retry budget",
    limit: 100,
  });
  const seen = new Set(results.map((result) => result.memory.id));
  expect(seen.size).toBeGreaterThan(0);
  for (const id of hidden) expect(seen.has(id)).toBe(false);
});

test("every character a CJK query gram can hold is one extract_cjk_grams indexes", async () => {
  // Exhaustive over Unicode: a doubled character is a two-code-point run, so
  // cjkLexicalGrams emits it as a gram exactly when the character belongs to the
  // query side's run class, and the database side must index it as its own term.
  const context = await createMemoryTestContext();
  const grams: string[] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    grams.push(...cjkLexicalGrams(character + character));
  }
  expect(grams.length).toBeGreaterThan(90_000);
  const missing = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ gram: string }>(
      `SELECT gram FROM unnest($1::text[]) AS gram
       WHERE NOT (lore.extract_cjk_grams(gram) @> ARRAY[gram])`,
      [grams],
    );
    return result.rows.map((row) => row.gram);
  });
  expect(missing).toEqual([]);
});

test("a query gram is an extract_cjk_grams term exactly when the content contains it", async () => {
  // The equivalence the CJK index rests on, over random text that mixes CJK runs
  // with what ends them: punctuation, the middle dot, fullwidth forms, Latin, digits,
  // spaces, and emoji.
  const context = await createMemoryTestContext();
  const alphabet = Array.from(
    "记忆召回质量审计结论データベースーバックアップ々ゝ서버재시작・、。「」ＡＢ１ ab1-🙂",
  );
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const text = (length: number) =>
    Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  const contents: string[] = [];
  const queryGrams: string[] = [];
  for (let index = 0; index < 400; index += 1) {
    const content = text(5 + Math.floor(random() * 40));
    const at = Math.floor(random() * content.length);
    for (const gram of [
      ...cjkLexicalGrams(text(2 + Math.floor(random() * 6))),
      ...cjkLexicalGrams(content.slice(at, at + 5)),
    ]) {
      contents.push(content);
      queryGrams.push(gram);
    }
  }
  const answers = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ contains: boolean; indexed: boolean }>(
      `SELECT pair.content LIKE ('%' || pair.gram || '%') AS contains,
              lore.extract_cjk_grams(pair.content) @> ARRAY[pair.gram] AS indexed
       FROM unnest($1::text[], $2::text[]) AS pair(content, gram)`,
      [contents, queryGrams],
    );
    return result.rows;
  });
  expect(answers.filter((answer) => answer.contains).length).toBeGreaterThan(100);
  expect(answers.filter((answer) => !answer.contains).length).toBeGreaterThan(100);
  for (const answer of answers) expect(answer.indexed).toBe(answer.contains);
});

test("each channel's probe uses its Workspace-leading index as the function's owner, and none can under RLS", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  // Enough unrelated chunks in the Workspace that a selective probe beats reading
  // the Workspace's rows through its btree.
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO memories (id, workspace_id, owner_user_id, scope, content)
       SELECT gen_random_uuid(), $1, $2, 'shared', 'filler note ' || n || ' 填充内容第' || n || '条'
       FROM generate_series(1, 3000) AS n`,
      [context.alice.workspaceId, context.alice.userId],
    );
    await transaction.query(
      `INSERT INTO memory_chunks (id, workspace_id, memory_id, ordinal, content, chunking_revision)
       SELECT gen_random_uuid(), workspace_id, id, 0, content, 'filler'
       FROM memories WHERE content LIKE 'filler note %'`,
    );
    await transaction.query("ANALYZE memory_chunks");
    await transaction.query("ANALYZE memories");
  });
  const probes = [
    [
      "memory_chunks_workspace_search_idx",
      "memory_chunks",
      "candidate.search_vector @@ websearch_to_tsquery('simple', 'staging retry')",
    ],
    [
      "memory_chunks_workspace_search_english_idx",
      "memory_chunks",
      "candidate.search_vector_english @@ plainto_tsquery('english', 'deploys')",
    ],
    [
      "memory_chunks_workspace_entity_aliases_idx",
      "memory_chunks",
      "candidate.entity_aliases @> ARRAY['Kestrel']",
    ],
    [
      "memory_chunks_workspace_cjk_grams_idx",
      "memory_chunks",
      "lore.extract_cjk_grams(candidate.content) @> ARRAY['召回质']",
    ],
    // The name channels (0017) probe memories through the same expressions.
    [
      "memories_workspace_name_search_idx",
      "memories",
      "to_tsvector('simple', lore.memory_name_text(candidate.title, candidate.gloss)) @@ websearch_to_tsquery('simple', 'Hyperdrive')",
    ],
    [
      "memories_workspace_name_search_english_idx",
      "memories",
      "to_tsvector('english', lore.memory_name_text(candidate.title, candidate.gloss)) @@ plainto_tsquery('english', 'rollback')",
    ],
    [
      "memories_workspace_name_cjk_grams_idx",
      "memories",
      "lore.extract_cjk_grams(lore.memory_name_text(candidate.title, candidate.gloss)) @> ARRAY['数据库']",
    ],
  ] as const;
  const plan = (asRequest: boolean, from: string, condition: string) =>
    (asRequest ? context.database : context.adminDatabase).transaction(async (transaction) => {
      if (asRequest) installActorContext(transaction, context.alice);
      await transaction.query("SET LOCAL enable_seqscan = off");
      const result = await transaction.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT candidate.id FROM ${from} candidate
         WHERE candidate.workspace_id = '${context.alice.workspaceId}'::uuid AND ${condition}`,
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  for (const [index, from, condition] of probes) {
    expect(await plan(false, from, condition), index).toMatch(
      new RegExp(`Bitmap Index Scan on ${index}\\b`),
    );
    expect(await plan(true, from, condition), index).not.toContain(index);
  }
});

test("a long query keeps its rarest terms by the caller's own visible sample, as the reference does", async () => {
  // Revision 25: past RETRIEVAL_RELAXED_TERM_POLICY.maximumTerms terms, the relaxed
  // channels keep the terms found in the fewest visible sampled chunks. Bob's private
  // notes all say "zebra", so zebra is frequent for Bob and rare for Alice.
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const memories = createMemoryModule(context.database);
  for (let index = 0; index < 30; index += 1) {
    await memories.remember(context.bob, {
      content: `Bob's zebra stable note ${index} about staging.`,
      scope: "private",
    });
  }
  await memories.remember(context.alice, {
    content: "The zebra crossing near the office closes on Friday for the Kestrel rollout.",
    scope: "shared",
  });
  const aliceAgent = await readerAgent(context, context.alice);
  const long =
    "zebra crossing office Friday Kestrel rollout staging retry budget deploys checklist";
  const queries: LexicalCandidateQuery[] = [
    { query: long, candidateLimit: 40, entityAliasRecall: true },
    { query: long, candidateLimit: 3 },
    { query: long, candidateLimit: 40, scope: "private" },
  ];
  const relaxed = new Map<string, string[]>();
  for (const [name, actor] of [
    ["alice", context.alice],
    ["bob", context.bob],
    ["alice's agent", aliceAgent.actor],
  ] as const) {
    for (const { query, host, reference } of await compareLexicalCandidates(
      createMemoryStorage(context.database, actor),
      queries,
    )) {
      expect(host, `${name} ${JSON.stringify(query)}`).toEqual(reference);
      if (query.candidateLimit === 40 && !query.scope) {
        relaxed.set(
          name,
          reference.filter((line) => line.startsWith("relaxed_english ")),
        );
      }
    }
  }
  // Alice keeps zebra, so the crossing note matches it with other kept terms.
  expect(relaxed.get("alice")?.length).toBeGreaterThan(0);
  expect(relaxed.get("alice")).toEqual(relaxed.get("alice's agent"));
});
