import type { EmbeddingTask } from "@corespeed/lore-core";
import { createMemoryMaintenanceModule } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createMemoryModule } from "@/modules/memories/service";
import { createAccessModule } from "@/server/auth/access";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import type { MemoryTestContext } from "../support/memory-context";
import { createMemoryTestContext } from "../support/memory-context";

// Migration 0004 rewrote the SELECT policies of memories, memory_chunks,
// memory_chunk_embeddings, and memory_links to evaluate the Membership/grant check
// once per statement. These cases pin the visibility they must keep.

const provider = {
  provider: "fixture",
  model: "fixture-embedding-v1",
  dimensions: 1024 as const,
  revision: "fixture-v1",
  async embed(texts: string[], _task: EmbeddingTask) {
    return texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)));
  },
};

async function fixture() {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database, { embeddingProvider: provider });
  const graph = createMemoryGraphModule(context.database);
  const access = createAccessModule(context.database);
  const aliceShared = await memories.remember(context.alice, { content: "Alice shared one." });
  const aliceSharedTwo = await memories.remember(context.alice, { content: "Alice shared two." });
  const alicePrivate = await memories.remember(context.alice, {
    content: "Alice private.",
    scope: "private",
  });
  const bobShared = await memories.remember(context.bob, { content: "Bob shared." });
  const bobPrivate = await memories.remember(context.bob, {
    content: "Bob private.",
    scope: "private",
  });
  await graph.connect(context.alice, {
    sourceMemoryId: aliceShared.id,
    targetMemoryId: aliceSharedTwo.id,
  });
  await graph.connect(context.alice, {
    sourceMemoryId: aliceShared.id,
    targetMemoryId: alicePrivate.id,
  });
  await graph.connect(context.bob, { sourceMemoryId: bobShared.id, targetMemoryId: bobPrivate.id });
  const maintenance = createMemoryMaintenanceModule(context.maintenanceDatabase, {
    embeddingProvider: provider,
  });
  while ((await maintenance.run()).status === "complete") {
    // Embed every Memory so the embedding policy is exercised.
  }
  const ids = {
    aliceShared: aliceShared.id,
    aliceSharedTwo: aliceSharedTwo.id,
    alicePrivate: alicePrivate.id,
    bobShared: bobShared.id,
    bobPrivate: bobPrivate.id,
  };
  return { access, context, ids };
}

async function readerAgent(
  access: ReturnType<typeof createAccessModule>,
  owner: ActorContext,
  name: string,
) {
  const agent = await access.createAgentForWorkspace(owner, { name, permission: "read" });
  const credential = await access.issueAgentCredential(owner, agent.id);
  const actor = await access.authenticateAgent(credential.token, owner.workspaceId);
  if (!actor) throw new Error(`Expected ${name} to authenticate`);
  return { agent, actor };
}

async function visible(context: MemoryTestContext, actor: ActorContext) {
  return context.database.transaction(async (transaction) => {
    await installActorContext(transaction, actor);
    const ids = async (sql: string) =>
      (await transaction.query<{ id: string }>(sql)).rows.map((row) => row.id).sort();
    return {
      memories: await ids("SELECT id FROM memories"),
      chunks: await ids("SELECT DISTINCT memory_id AS id FROM memory_chunks"),
      embeddings: await ids("SELECT DISTINCT memory_id AS id FROM memory_chunk_embeddings"),
      links: await ids(
        "SELECT source_memory_id::text || '>' || target_memory_id::text AS id FROM memory_links",
      ),
    };
  });
}

function expected(memoryIds: string[], links: Array<[string, string]>) {
  const sorted = [...memoryIds].sort();
  return {
    memories: sorted,
    chunks: sorted,
    embeddings: sorted,
    links: links.map(([source, target]) => `${source}>${target}`).sort(),
  };
}

const nothing = { memories: [], chunks: [], embeddings: [], links: [] };

test("owners and their Agents see shared rows plus the owner's private rows", async () => {
  const { access, context, ids } = await fixture();
  const aliceView = expected(
    [ids.aliceShared, ids.aliceSharedTwo, ids.alicePrivate, ids.bobShared],
    [
      [ids.aliceShared, ids.aliceSharedTwo],
      [ids.aliceShared, ids.alicePrivate],
    ],
  );
  const bobView = expected(
    [ids.aliceShared, ids.aliceSharedTwo, ids.bobShared, ids.bobPrivate],
    [
      [ids.aliceShared, ids.aliceSharedTwo],
      [ids.bobShared, ids.bobPrivate],
    ],
  );

  await expect(visible(context, context.alice)).resolves.toEqual(aliceView);
  await expect(visible(context, context.bob)).resolves.toEqual(bobView);
  const aliceAgent = await readerAgent(access, context.alice, "Alice reader");
  const bobAgent = await readerAgent(access, context.bob, "Bob reader");
  await expect(visible(context, aliceAgent.actor)).resolves.toEqual(aliceView);
  await expect(visible(context, bobAgent.actor)).resolves.toEqual(bobView);
});

test("non-members, other Workspaces, and forged Agent contexts see nothing", async () => {
  const { access, context } = await fixture();
  const bobAgent = await readerAgent(access, context.bob, "Bob reader");

  await expect(
    visible(context, { workspaceId: context.alice.workspaceId, userId: context.carol.userId }),
  ).resolves.toEqual(nothing);
  await expect(
    visible(context, { workspaceId: context.carol.workspaceId, userId: context.alice.userId }),
  ).resolves.toEqual(nothing);
  await expect(visible(context, context.carol)).resolves.toEqual(nothing);
  // Alice's session claiming Bob's Agent: the Agent is not owned by the session User.
  await expect(visible(context, { ...context.alice, agentId: bobAgent.agent.id })).resolves.toEqual(
    nothing,
  );
});

test("a suspended Membership denies the member and every Agent the member owns", async () => {
  const { access, context } = await fixture();
  const bobAgent = await readerAgent(access, context.bob, "Bob reader");

  await context.suspendMembership(context.bob);

  await expect(visible(context, context.bob)).resolves.toEqual(nothing);
  await expect(visible(context, bobAgent.actor)).resolves.toEqual(nothing);
});

test("a revoked grant or a disabled Agent denies that Agent", async () => {
  const { access, context, ids } = await fixture();
  const revoked = await readerAgent(access, context.alice, "Revoked reader");
  const disabled = await readerAgent(access, context.alice, "Disabled reader");

  await access.revokeAgentGrant(context.alice, revoked.agent.id);
  await access.updateAgent(context.alice, disabled.agent.id, { status: "disabled" });

  await expect(visible(context, revoked.actor)).resolves.toEqual(nothing);
  await expect(visible(context, disabled.actor)).resolves.toEqual(nothing);
  // The owner is unaffected.
  await expect(visible(context, context.alice)).resolves.toMatchObject({
    memories: expect.arrayContaining([ids.alicePrivate]),
  });
});

test("the Workspace read check is planned once per statement, not per row", async () => {
  const { context } = await fixture();
  await context.database.transaction(async (transaction) => {
    await installActorContext(transaction, context.alice);
    for (const sql of [
      "SELECT id FROM memories",
      "SELECT id FROM memory_chunks",
      "SELECT chunk_id FROM memory_chunk_embeddings",
      "SELECT id FROM memory_links",
    ]) {
      const plan = (
        await transaction.query<{ "QUERY PLAN": string }>(`EXPLAIN (VERBOSE, COSTS OFF) ${sql}`)
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      expect(plan, sql).toMatch(/InitPlan/);
      // A row-dependent call would name a column, e.g. is_active_member(memory.workspace_id).
      expect(plan, sql).not.toMatch(/(?:is_active_member|agent_has_access)\(\w+\.workspace_id/);
    }
  });
});
