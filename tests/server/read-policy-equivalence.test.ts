import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createMemoryModule } from "@/modules/memories/service";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

// Migration 0021 rewrote these read policies so the Membership or grant check runs
// once per statement instead of once per row. Each new policy must show exactly the
// rows the old expression showed. Here every old expression (through revision 20)
// is evaluated directly, as the table owner with the same Actor settings, and
// compared with what lore_app sees through RLS. Rows are inserted raw, with
// triggers and foreign keys off, so the corpus also holds rows whose parent is
// missing, private, expired, or in another Workspace.

const canReadMemory = (alias: string) =>
  `lore.can_read_memory(${alias}.workspace_id, ${alias}.owner_user_id, ${alias}.scope)`;
const visibleProposal = (alias: string) =>
  `lore.can_read_memory_proposal(${alias}.workspace_id, ${alias}.owner_user_id) AND ${alias}.expires_at > now()`;

/** Each table, the key its rows are compared by, and its read policy through revision 20. */
const OLD_POLICIES: { table: string; key: string; using: string }[] = [
  { table: "episodes", key: "t.id::text", using: canReadMemory("t") },
  {
    table: "observations",
    key: "t.id::text",
    using: `EXISTS (SELECT 1 FROM episodes episode
      WHERE episode.id = t.episode_id AND episode.workspace_id = t.workspace_id
        AND ${canReadMemory("episode")})`,
  },
  {
    table: "episode_evidence_chunks",
    key: "t.id::text",
    using: `t.workspace_id = lore.current_workspace_id() AND EXISTS (
      SELECT 1 FROM episodes episode
      WHERE episode.id = t.episode_id AND episode.workspace_id = t.workspace_id
        AND ${canReadMemory("episode")})`,
  },
  {
    table: "episode_evidence_chunk_embeddings",
    key: "t.chunk_id::text || ' ' || t.generation_id::text",
    using: `t.workspace_id = lore.current_workspace_id() AND EXISTS (
      SELECT 1 FROM episode_evidence_chunks chunk
      JOIN episodes episode ON episode.id = chunk.episode_id AND episode.workspace_id = chunk.workspace_id
      JOIN embedding_generations generation ON generation.id = t.generation_id
      WHERE chunk.id = t.chunk_id AND chunk.workspace_id = t.workspace_id
        AND generation.status IN ('active', 'retiring')
        AND ${canReadMemory("episode")})`,
  },
  {
    table: "memory_events",
    key: "t.id::text",
    using: `(t.resource_type = 'memory' AND (
        EXISTS (SELECT 1 FROM memories memory
          WHERE memory.workspace_id = t.workspace_id AND memory.id = t.resource_id
            AND ${canReadMemory("memory")})
        OR (t.event_type = 'memory.deleted'
          AND lore.can_read_memory(t.workspace_id, t.owner_user_id, t.memory_scope))))
      OR (t.resource_type = 'memory_link' AND EXISTS (
        SELECT 1 FROM memories source_memory
        JOIN memories target_memory ON target_memory.workspace_id = source_memory.workspace_id
          AND target_memory.id = t.related_memory_id
        WHERE source_memory.workspace_id = t.workspace_id AND source_memory.id = t.source_memory_id
          AND ${canReadMemory("source_memory")} AND ${canReadMemory("target_memory")}))`,
  },
  {
    table: "memory_import_provenance",
    key: "t.memory_id::text",
    using: `EXISTS (SELECT 1 FROM memories memory
      WHERE memory.workspace_id = t.workspace_id AND memory.id = t.memory_id
        AND ${canReadMemory("memory")})`,
  },
  {
    table: "memory_code_evidence",
    key: "t.id::text",
    using: `t.workspace_id = lore.current_workspace_id()
      AND lore.can_read_code_index(lore.current_workspace_id())
      AND EXISTS (SELECT 1 FROM memories memory
        WHERE memory.workspace_id = t.workspace_id AND memory.id = t.memory_id
          AND ${canReadMemory("memory")})`,
  },
  {
    table: "memory_observation_evidence",
    key: "t.memory_id::text || ' ' || t.observation_id::text",
    using: `t.workspace_id = lore.current_workspace_id()
      AND EXISTS (SELECT 1 FROM memories memory
        WHERE memory.workspace_id = t.workspace_id AND memory.id = t.memory_id
          AND ${canReadMemory("memory")})
      AND EXISTS (SELECT 1 FROM observations observation
        JOIN episodes episode ON episode.workspace_id = observation.workspace_id
          AND episode.id = observation.episode_id
        WHERE observation.workspace_id = t.workspace_id AND observation.id = t.observation_id
          AND ${canReadMemory("episode")})`,
  },
  { table: "memory_proposals", key: "t.id::text", using: visibleProposal("t") },
  {
    table: "memory_proposal_evidence",
    key: "t.proposal_id::text || ' ' || t.ordinal",
    using: `EXISTS (SELECT 1 FROM memory_proposals proposal
        WHERE proposal.id = t.proposal_id AND proposal.workspace_id = t.workspace_id
          AND ${visibleProposal("proposal")})
      AND EXISTS (SELECT 1 FROM memories memory
        WHERE memory.id = t.memory_id AND memory.workspace_id = t.workspace_id
          AND ${canReadMemory("memory")})`,
  },
  {
    table: "memory_proposal_code_evidence",
    key: "t.proposal_id::text || ' ' || t.ordinal",
    using: `EXISTS (SELECT 1 FROM memory_proposals proposal
      WHERE proposal.id = t.proposal_id AND proposal.workspace_id = t.workspace_id
        AND ${visibleProposal("proposal")})`,
  },
  {
    table: "memory_proposal_observation_evidence",
    key: "t.proposal_id::text || ' ' || t.ordinal",
    using: `EXISTS (SELECT 1 FROM memory_proposals proposal
      WHERE proposal.id = t.proposal_id AND proposal.workspace_id = t.workspace_id
        AND ${visibleProposal("proposal")})`,
  },
];

const SHA = "a".repeat(64);
const OID = "b".repeat(40);

async function seedCorpus(context: MemoryTestContext) {
  const memories = createMemoryModule(context.database);
  const graph = createMemoryGraphModule(context.database);
  const owners = [context.alice, context.bob, context.carol];
  const memoryIds: string[] = [];
  for (const owner of owners) {
    for (const scope of ["shared", "private"] as const) {
      const first = await memories.remember(owner, {
        content: `${owner.userId} ${scope} one`,
        scope,
      });
      const second = await memories.remember(owner, {
        content: `${owner.userId} ${scope} two`,
        scope,
      });
      await graph.connect(owner, { sourceMemoryId: first.id, targetMemoryId: second.id });
      const doomed = await memories.remember(owner, {
        content: `${owner.userId} ${scope} gone`,
        scope,
      });
      await memories.forget(owner, doomed.id);
      memoryIds.push(first.id, second.id);
    }
  }
  // A Link from a shared Memory to a private one: its events need both visible.
  const [aliceShared] = memoryIds;
  const alicePrivate = memoryIds[2];
  if (!aliceShared || !alicePrivate) throw new Error("Expected Alice's Memories");
  await graph.connect(context.alice, { sourceMemoryId: aliceShared, targetMemoryId: alicePrivate });

  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query("SET LOCAL session_replication_role = replica");
    const generations = await transaction.query<{ id: string }>(
      `INSERT INTO embedding_generations
         (id, embedding_provider, embedding_model, embedding_dimensions, embedding_revision,
          status, activated_at, retired_at)
       VALUES (gen_random_uuid(), 'policy', 'retiring-model', 1024, 'v1', 'retiring', now(), now()),
              (gen_random_uuid(), 'policy', 'building-model', 1024, 'v1', 'building', NULL, NULL)
       RETURNING id`,
    );
    const workspaces = [context.alice.workspaceId, context.carol.workspaceId];
    const observationIds: string[] = [];
    const episodeOwners: [ActorContext, string][] = [];
    for (const owner of owners) {
      for (const scope of ["shared", "private"] as const) {
        const episodeId = randomUUID();
        episodeOwners.push([owner, episodeId]);
        await transaction.query(
          `INSERT INTO episodes (id, workspace_id, owner_user_id, recorded_by_actor_kind, kind,
             scope, started_at, ended_at)
           VALUES ($1, $2, $3, 'human', 'conversation', $4, now(), now())`,
          [episodeId, owner.workspaceId, owner.userId, scope],
        );
        for (let ordinal = 0; ordinal < 2; ordinal += 1) {
          const observationId = randomUUID();
          observationIds.push(observationId);
          await transaction.query(
            `INSERT INTO observations (id, workspace_id, episode_id, ordinal, kind, observed_at,
               payload_sha256, content)
             VALUES ($1, $2, $3, $4, 'message', now(), $5, 'observed')`,
            [observationId, owner.workspaceId, episodeId, ordinal, SHA],
          );
          const chunk = await transaction.query<{ id: string }>(
            `INSERT INTO episode_evidence_chunks (workspace_id, episode_id, observation_id,
               observation_ordinal, chunk_ordinal, content, index_revision)
             VALUES ($1, $2, $3, $4, 0, 'observed', 'policy') RETURNING id`,
            [owner.workspaceId, episodeId, observationId, ordinal],
          );
          for (const generation of generations.rows) {
            await transaction.query(
              `INSERT INTO episode_evidence_chunk_embeddings (generation_id, workspace_id,
                 episode_id, observation_id, chunk_id, embedding)
               VALUES ($1, $2, $3, $4, $5, array_fill(0.5::real, ARRAY[1024])::vector)`,
              [generation.id, owner.workspaceId, episodeId, observationId, chunk.rows[0]?.id],
            );
          }
        }
      }
    }
    // Evidence on every Memory, including one whose Memory does not exist.
    for (const memoryId of [...memoryIds, randomUUID()]) {
      for (const workspaceId of workspaces) {
        await transaction.query(
          `INSERT INTO memory_import_provenance (workspace_id, memory_id, import_id,
             source_memory_id, source_owner_user_id, source_created_at, source_updated_at)
           VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), $3, now(), now())`,
          [workspaceId, memoryId, context.alice.userId],
        );
        await transaction.query(
          `INSERT INTO memory_code_evidence (id, workspace_id, memory_id, repository_id,
             cited_revision_id, cited_generation_id, cited_artifact_id, cited_commit_oid,
             relationship, cited_path, cited_content_sha256, validation_state, created_by_user_id)
           VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), gen_random_uuid(),
             gen_random_uuid(), gen_random_uuid(), $3, 'supports', 'src/a.ts', $4,
             'unverifiable', $5)`,
          [workspaceId, memoryId, OID, SHA, context.alice.userId],
        );
      }
      // Each pair once, in alternating Workspaces, so some rows name another one's.
      for (const [index, observationId] of observationIds.entries()) {
        await transaction.query(
          `INSERT INTO memory_observation_evidence (workspace_id, memory_id, observation_id,
             created_by_user_id)
           VALUES ($1, $2, $3, $4)`,
          [workspaces[index % 2], memoryId, observationId, context.alice.userId],
        );
      }
    }
    // Pending Proposals of each owner, live and expired.
    for (const owner of owners) {
      for (const createdAt of ["now()", "now() - interval '31 days'"]) {
        const proposal = await transaction.query<{ id: string }>(
          `INSERT INTO memory_proposals (id, workspace_id, owner_user_id, proposed_by_actor_kind,
             kind, proposed_content, proposed_scope, changes_content, changes_scope,
             changes_metadata, created_at, expires_at)
           VALUES (gen_random_uuid(), $1, $2, 'human', 'create', 'proposed', 'shared',
             true, true, true, ${createdAt}, ${createdAt} + interval '30 days')
           RETURNING id`,
          [owner.workspaceId, owner.userId],
        );
        const proposalId = proposal.rows[0]?.id;
        for (const [ordinal, memoryId] of [...memoryIds, randomUUID()].entries()) {
          await transaction.query(
            `INSERT INTO memory_proposal_evidence (workspace_id, proposal_id, memory_id, ordinal)
             VALUES ($1, $2, $3, $4)`,
            [owner.workspaceId, proposalId, memoryId, ordinal],
          );
        }
        await transaction.query(
          `INSERT INTO memory_proposal_code_evidence (workspace_id, proposal_id, ordinal,
             repository_id, cited_revision_id, cited_generation_id, cited_artifact_id,
             cited_commit_oid, relationship, cited_path, cited_content_sha256)
           VALUES ($1, $2, 0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
             gen_random_uuid(), $3, 'supports', 'src/a.ts', $4)`,
          [owner.workspaceId, proposalId, OID, SHA],
        );
        await transaction.query(
          `INSERT INTO memory_proposal_observation_evidence (workspace_id, proposal_id,
             observation_reference_id, ordinal)
           VALUES ($1, $2, gen_random_uuid(), 0)`,
          [owner.workspaceId, proposalId],
        );
      }
    }
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

/** Rows lore_app sees through RLS, and rows the old expression shows, per table. */
async function compare(context: MemoryTestContext, actor: ActorContext | null) {
  const answers: { table: string; policy: string[]; reference: string[] }[] = [];
  for (const { table, key, using } of OLD_POLICIES) {
    const select = (where: string) => `SELECT ${key} AS key FROM ${table} t ${where} ORDER BY 1`;
    const keys = (rows: { key: string }[]) => rows.map((row) => row.key);
    const policy = await context.database.transaction(async (transaction) => {
      if (actor) installActorContext(transaction, actor);
      return keys((await transaction.query<{ key: string }>(select(""))).rows);
    });
    const reference = await context.adminDatabase.transaction(async (transaction) => {
      if (actor) installActorContext(transaction, actor);
      return keys((await transaction.query<{ key: string }>(select(`WHERE ${using}`))).rows);
    });
    answers.push({ table, policy, reference });
  }
  return answers;
}

test("each rewritten read policy shows exactly the rows its old expression showed", async () => {
  const context = await createMemoryTestContext();
  await seedCorpus(context);
  const aliceAgent = await readerAgent(context, context.alice);
  const bobAgent = await readerAgent(context, context.bob);
  const actors: [string, ActorContext | null][] = [
    ["alice", context.alice],
    ["bob", context.bob],
    ["carol", context.carol],
    ["alice's agent", aliceAgent.actor],
    ["bob's agent", bobAgent.actor],
    ["no actor", null],
  ];

  const seen = new Map<string, number>();
  for (const [name, actor] of actors) {
    for (const { table, policy, reference } of await compare(context, actor)) {
      expect(policy, `${name} ${table}`).toEqual(reference);
      seen.set(table, (seen.get(table) ?? 0) + reference.length);
    }
  }
  // The comparison means something only when every table shows rows to someone.
  for (const { table } of OLD_POLICIES) expect(seen.get(table), table).toBeGreaterThan(0);

  // A revoked grant and a suspended Membership show nothing either way.
  await context.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE agent_workspace_grants SET status = 'revoked' WHERE agent_id = $1", [
      aliceAgent.agentId,
    ]),
  );
  await context.suspendMembership(context.bob);
  for (const actor of [aliceAgent.actor, context.bob, bobAgent.actor]) {
    for (const { table, policy, reference } of await compare(context, actor)) {
      expect(reference, table).toEqual([]);
      expect(policy, table).toEqual([]);
    }
  }
});

test("no rewritten read policy checks Membership or grants once per row", async () => {
  const context = await createMemoryTestContext();
  const policies = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ table: string; qual: string }>(
      `SELECT tablename AS table, qual FROM pg_policies
       WHERE schemaname = 'public' AND cmd = 'SELECT' AND tablename = ANY($1::text[])`,
      [OLD_POLICIES.map((policy) => policy.table)],
    );
    return result.rows;
  });
  expect(policies.length).toBe(OLD_POLICIES.length);
  for (const { table, qual } of policies) {
    // Only an InitPlan on the session's Workspace may call a membership check.
    const perRow = qual
      .replaceAll(
        /\(\s*SELECT lore\.can_read_(workspace|code_index)\(lore\.current_workspace_id\(\)\)[^)]*\)/g,
        "",
      )
      .replaceAll(
        /\(\s*SELECT \(+lore\.current_agent_id\(\) IS NULL\) AND lore\.is_active_member\(lore\.current_workspace_id\(\)\)\)?[^)]*\)/g,
        "",
      );
    expect(perRow, table).not.toMatch(
      /lore\.(can_read_memory|can_read_memory_proposal|is_active_member|agent_has_access|can_read_workspace)\(/,
    );
  }
});
