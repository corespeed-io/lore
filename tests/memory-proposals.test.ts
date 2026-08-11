import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import { installActorContext } from "@/lib/actor-context";
import { createMemoryGraphModule } from "@/lib/graph";
import { purgeExpiredPortableCoreRecords } from "@/lib/maintenance";
import {
  createMemoryModule,
  MemoryProposalAccessDeniedError,
  MemoryProposalCapacityError,
  MemoryProposalReviewConflictError,
  MemoryVersionConflictError,
} from "@/lib/memory";
import { createObservationModule } from "@/lib/observations";
import { createPortabilityModule } from "@/lib/portability";
import { createMemoryTestContext } from "./support/memory-context";

async function createWritingAgent() {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Dream assistant" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "write" });
  return {
    access,
    agent,
    agentActor: { ...testContext.alice, agentId: agent.id },
    testContext,
  };
}

test("Agent proposal remains private and non-canonical until its owner accepts it", async () => {
  const { agent, agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const portability = createPortabilityModule(testContext.database);
  const evidence = await memories.remember(testContext.alice, {
    content: "The planning meeting moved the launch.",
    scope: "private",
  });

  const proposal = await memories.propose(agentActor, {
    kind: "create",
    content: "The launch moved to Tuesday.",
    scope: "shared",
    metadata: { type: "decision" },
    evidenceMemoryIds: [evidence.id],
  });

  expect(proposal).toMatchObject({
    kind: "create",
    ownerUserId: testContext.alice.userId,
    proposedByAgentId: agent.id,
    status: "pending",
    acceptedMemoryId: null,
    evidenceMemoryIds: [evidence.id],
  });
  await expect(memories.list(testContext.alice)).resolves.toMatchObject([{ id: evidence.id }]);
  await expect(memories.list(testContext.bob)).resolves.toEqual([]);
  await expect(memories.search(testContext.alice, { query: "Tuesday" })).resolves.toEqual([]);
  await expect(memories.listProposals(testContext.alice)).resolves.toEqual([proposal]);
  await expect(graph.read(testContext.alice)).resolves.toMatchObject({
    nodes: [{ id: evidence.id }],
  });
  await expect(portability.exportWorkspace(testContext.alice)).resolves.toMatchObject({
    memories: [{ id: evidence.id }],
  });
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    const events = await transaction.execute<{ resource_id: string }>(
      sql.raw("SELECT resource_id FROM memory_events ORDER BY sequence"),
    );
    expect(events.rows).toEqual([{ resource_id: evidence.id }]);
  });

  const accepted = await memories.reviewProposal(testContext.alice, proposal.id, "accept");

  expect(accepted?.proposal).toMatchObject({
    id: proposal.id,
    status: "accepted",
    reviewedByUserId: testContext.alice.userId,
    acceptedMemoryId: accepted?.memory?.id,
  });
  expect(accepted?.memory).toMatchObject({
    ownerUserId: testContext.alice.userId,
    createdByAgentId: null,
    content: "The launch moved to Tuesday.",
    scope: "shared",
  });
  await expect(memories.list(testContext.bob)).resolves.toMatchObject([
    { id: accepted?.memory?.id },
  ]);

  await testContext.close();
});

test("Proposal acceptance and rejection are replay-safe without duplicate Memories", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const acceptedProposal = await memories.propose(testContext.alice, {
    kind: "create",
    content: "Accepted once",
  });

  const first = await memories.reviewProposal(testContext.alice, acceptedProposal.id, "accept");
  const replay = await memories.reviewProposal(testContext.alice, acceptedProposal.id, "accept");

  expect(replay).toEqual(first);
  await expect(memories.list(testContext.alice)).resolves.toHaveLength(1);
  await expect(
    memories.reviewProposal(testContext.alice, acceptedProposal.id, "reject"),
  ).rejects.toBeInstanceOf(MemoryProposalReviewConflictError);

  const rejectedProposal = await memories.propose(testContext.alice, {
    kind: "create",
    content: "Never canonical",
  });
  const rejected = await memories.reviewProposal(testContext.alice, rejectedProposal.id, "reject");
  const rejectedReplay = await memories.reviewProposal(
    testContext.alice,
    rejectedProposal.id,
    "reject",
  );

  expect(rejectedReplay).toEqual(rejected);
  expect(rejected?.memory).toBeNull();
  await expect(memories.list(testContext.alice)).resolves.toHaveLength(1);

  if (!first?.memory) throw new Error("Expected accepted proposal to create a Memory");
  await expect(
    memories.forget(testContext.alice, first.memory.id, {
      expectedVersion: first.memory.version,
    }),
  ).resolves.toBe(true);
  await expect(memories.listProposals(testContext.alice, { status: "accepted" })).resolves.toEqual(
    [],
  );
  await expect(
    memories.reviewProposal(testContext.alice, acceptedProposal.id, "accept"),
  ).resolves.toBeNull();

  await testContext.close();
});

test("Database review transition rejects a forged accepted receipt", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const proposal = await memories.propose(testContext.alice, {
    kind: "create",
    content: "Receipt must match the canonical Memory",
  });

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await expect(
      transaction.execute(sql`UPDATE memory_proposals
         SET status = 'accepted',
             reviewed_by_user_id = ${testContext.alice.userId},
             accepted_memory_id = ${crypto.randomUUID()},
             reviewed_at = now(),
             expires_at = now() + interval '30 days'
         WHERE id = ${proposal.id}`),
    ).rejects.toThrow("Accepted create receipt must match the canonical Memory");
  });
  await expect(memories.listProposals(testContext.alice)).resolves.toMatchObject([
    { id: proposal.id, status: "pending" },
  ]);

  const target = await memories.remember(testContext.alice, {
    content: "Original canonical content",
  });
  const updateProposal = await memories.propose(testContext.alice, {
    kind: "update",
    targetMemoryId: target.id,
    expectedVersion: target.version,
    content: "Proposed canonical content",
  });
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await expect(
      transaction.execute(sql`UPDATE memory_proposals
         SET status = 'accepted',
             reviewed_by_user_id = ${testContext.alice.userId},
             accepted_memory_id = ${crypto.randomUUID()},
             reviewed_at = now(),
             expires_at = now() + interval '30 days'
         WHERE id = ${updateProposal.id}`),
    ).rejects.toThrow("Accepted update receipt must match the canonical Memory");
  });

  await testContext.close();
});

test("Pending proposal capacity keeps every proposal manageable in the native inbox", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.execute(sql`INSERT INTO memory_proposals (
         id, workspace_id, owner_user_id, proposed_by_actor_kind,
         proposed_by_agent_id, kind, target_memory_id, base_memory_version,
         proposed_content, proposed_scope, proposed_metadata,
         changes_content, changes_scope, changes_metadata
       )
       SELECT gen_random_uuid(), ${testContext.alice.workspaceId}, ${testContext.alice.userId}, 'human', NULL, 'create', NULL, NULL,
              'Pending proposal ' || ordinal, 'shared', '{}'::jsonb,
              true, true, true
       FROM generate_series(1, 100) ordinal`);
  });

  await expect(
    memories.propose(testContext.alice, { kind: "create", content: "One proposal too many" }),
  ).rejects.toBeInstanceOf(MemoryProposalCapacityError);
  const [pending] = await memories.listProposals(testContext.alice, {
    status: "pending",
    limit: 100,
  });
  await memories.reviewProposal(testContext.alice, pending.id, "reject");
  await expect(
    memories.propose(testContext.alice, { kind: "create", content: "Capacity restored" }),
  ).resolves.toMatchObject({ status: "pending" });

  await testContext.close();
});

test("Only the owner human can list or review an Agent proposal", async () => {
  const { agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const proposal = await memories.propose(agentActor, {
    kind: "create",
    content: "Owner-private proposal",
  });

  await expect(memories.listProposals(agentActor)).rejects.toBeInstanceOf(
    MemoryProposalAccessDeniedError,
  );
  await expect(memories.reviewProposal(agentActor, proposal.id, "accept")).rejects.toBeInstanceOf(
    MemoryProposalAccessDeniedError,
  );
  await expect(memories.listProposals(testContext.bob)).resolves.toEqual([]);
  await expect(memories.reviewProposal(testContext.bob, proposal.id, "accept")).resolves.toBeNull();
  await expect(memories.list(testContext.alice)).resolves.toEqual([]);

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, agentActor);
    await expect(
      transaction.execute(sql`SELECT id FROM memory_proposals WHERE id = ${proposal.id}`),
    ).resolves.toMatchObject({ rows: [] });
  });

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    await expect(
      transaction.execute(sql.raw("SELECT id FROM memory_proposals")),
    ).resolves.toMatchObject({
      rows: [],
    });
  });

  await testContext.close();
});

test("Deleting the submitting Agent preserves proposal content and actor kind", async () => {
  const { agent, agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const proposal = await memories.propose(agentActor, {
    kind: "create",
    content: "Keep this suggestion after its Agent is removed",
  });

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await expect(
      transaction.execute(
        sql`UPDATE memory_proposals SET proposed_by_agent_id = NULL WHERE id = ${proposal.id}`,
      ),
    ).rejects.toThrow("Memory Proposal provenance is immutable");
  });

  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.execute(sql`DELETE FROM agents WHERE id = ${agent.id}`);
  });

  await expect(memories.listProposals(testContext.alice)).resolves.toMatchObject([
    {
      id: proposal.id,
      proposedByActorKind: "agent",
      proposedByAgentId: null,
      proposedContent: "Keep this suggestion after its Agent is removed",
      status: "pending",
    },
  ]);

  await testContext.close();
});

test("Update proposal applies only to the exact reviewed Memory version", async () => {
  const { agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const original = await memories.remember(testContext.alice, {
    content: "Launch Monday",
    scope: "private",
    metadata: { type: "plan" },
  });
  const proposal = await memories.propose(agentActor, {
    kind: "update",
    targetMemoryId: original.id,
    expectedVersion: original.version,
    content: "Launch Tuesday",
  });

  await memories.update(
    testContext.alice,
    original.id,
    { content: "Launch Wednesday" },
    { expectedVersion: original.version },
  );

  await expect(
    memories.reviewProposal(testContext.alice, proposal.id, "accept"),
  ).rejects.toBeInstanceOf(MemoryVersionConflictError);
  await expect(memories.listProposals(testContext.alice)).resolves.toMatchObject([
    { id: proposal.id, status: "pending", baseMemoryVersion: original.version },
  ]);
  await expect(memories.retrieve(testContext.alice, original.id)).resolves.toMatchObject({
    content: "Launch Wednesday",
    version: original.version + 1,
  });

  await testContext.close();
});

test("Deleting a target removes proposal content and prevents later acceptance", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const target = await memories.remember(testContext.alice, {
    content: "A canonical fact that may be deleted",
    scope: "private",
  });
  const proposal = await memories.propose(testContext.alice, {
    kind: "update",
    targetMemoryId: target.id,
    expectedVersion: target.version,
    content: "A proposed replacement",
  });

  await expect(
    memories.forget(testContext.alice, target.id, { expectedVersion: target.version }),
  ).resolves.toBe(true);
  await expect(
    memories.reviewProposal(testContext.alice, proposal.id, "accept"),
  ).resolves.toBeNull();
  await expect(memories.listProposals(testContext.alice)).resolves.toEqual([]);

  await testContext.close();
});

test("Expired proposal content is purged with Portable Core retention", async () => {
  const testContext = await createMemoryTestContext();
  const proposalId = crypto.randomUUID();

  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.execute(sql`INSERT INTO memory_proposals (
         id, workspace_id, owner_user_id, proposed_by_actor_kind,
         kind, proposed_content, proposed_scope, proposed_metadata,
         changes_content, changes_scope, changes_metadata, status,
         reviewed_by_user_id, created_at, reviewed_at, expires_at
       ) VALUES (
         ${proposalId}, ${testContext.alice.workspaceId}, ${testContext.alice.userId}, 'human', 'create', 'Expired private proposal',
         'private', '{}'::jsonb, true, true, true, 'rejected', ${testContext.alice.userId},
         now() - interval '61 days', now() - interval '31 days',
         now() - interval '1 day'
       )`);
  });
  const memories = createMemoryModule(testContext.database);
  await expect(memories.listProposals(testContext.alice)).resolves.toEqual([]);
  await purgeExpiredPortableCoreRecords(testContext.maintenanceDatabase);
  await testContext.adminDatabase.transaction(async (transaction) => {
    await expect(
      transaction.execute(sql`SELECT id FROM memory_proposals WHERE id = ${proposalId}`),
    ).resolves.toMatchObject({ rows: [] });
  });

  await testContext.close();
});

test("Database target validation rejects a cross-owner update proposal", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const bobPrivate = await memories.remember(testContext.bob, {
    content: "Bob-owned target",
    scope: "private",
  });

  await testContext.adminDatabase.transaction(async (transaction) => {
    await expect(
      transaction.execute(sql`INSERT INTO memory_proposals (
           id, workspace_id, owner_user_id, proposed_by_actor_kind, kind,
           target_memory_id, base_memory_version, proposed_content,
           proposed_scope, proposed_metadata, changes_content, changes_scope,
           changes_metadata
         ) VALUES (
           ${crypto.randomUUID()}, ${testContext.alice.workspaceId}, ${testContext.alice.userId}, 'human', 'update', ${bobPrivate.id}, 1, ${"Cross-owner proposal"}, 'private', '{}'::jsonb,
           true, false, false
         )`),
    ).rejects.toThrow("Memory Proposal target must be an owned Memory in this Workspace");
  });

  await expect(memories.listProposals(testContext.alice)).resolves.toEqual([]);
  await testContext.close();
});

test("Accepted update changes canonical content, chunks, and outbox in one transaction", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const original = await memories.remember(testContext.alice, {
    content: "Old operational fact",
    scope: "private",
  });
  const evidence = await memories.remember(testContext.alice, {
    content: "Meeting evidence",
    scope: "private",
  });
  const proposal = await memories.propose(testContext.alice, {
    kind: "update",
    targetMemoryId: original.id,
    expectedVersion: original.version,
    content: "New operational fact",
    evidenceMemoryIds: [evidence.id],
  });

  const accepted = await memories.reviewProposal(testContext.alice, proposal.id, "accept");

  expect(accepted?.proposal).toMatchObject({
    evidenceMemoryIds: [evidence.id],
    acceptedMemoryId: original.id,
    status: "accepted",
  });
  expect(accepted?.memory).toMatchObject({
    id: original.id,
    content: "New operational fact",
    version: original.version + 1,
  });
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    const chunks = await transaction.execute<{ content: string }>(
      sql`SELECT content FROM memory_chunks WHERE memory_id = ${original.id} ORDER BY ordinal`,
    );
    const events = await transaction.execute<{ event_type: string }>(sql`SELECT event_type
       FROM memory_events
       WHERE resource_id = ${original.id}
       ORDER BY sequence`);
    expect(chunks.rows).toEqual([{ content: "New operational fact" }]);
    expect(events.rows.map((row) => row.event_type)).toEqual(["memory.created", "memory.updated"]);
  });

  await testContext.close();
});

test("Accepting a metadata-only proposal preserves canonical chunks", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const original = await memories.remember(testContext.alice, {
    content: "Content whose chunks should remain stable",
    scope: "private",
    metadata: { state: "draft" },
  });
  const before = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    return transaction.execute<{ id: string }>(
      sql`SELECT id FROM memory_chunks WHERE memory_id = ${original.id} ORDER BY ordinal`,
    );
  });
  const proposal = await memories.propose(testContext.alice, {
    kind: "update",
    targetMemoryId: original.id,
    expectedVersion: original.version,
    metadata: { state: "approved" },
  });

  const accepted = await memories.reviewProposal(testContext.alice, proposal.id, "accept");
  const after = await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    return transaction.execute<{ id: string }>(
      sql`SELECT id FROM memory_chunks WHERE memory_id = ${original.id} ORDER BY ordinal`,
    );
  });

  expect(accepted?.memory).toMatchObject({
    content: original.content,
    scope: original.scope,
    metadata: { state: "approved" },
    version: original.version + 1,
  });
  expect(after.rows).toEqual(before.rows);

  await testContext.close();
});

test("Proposal evidence cannot include a private Memory hidden from the Actor", async () => {
  const { agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const bobPrivate = await memories.remember(testContext.bob, {
    content: "Bob private evidence",
    scope: "private",
  });

  await expect(
    memories.propose(agentActor, {
      kind: "create",
      content: "Attempted synthesis",
      evidenceMemoryIds: [bobPrivate.id],
    }),
  ).rejects.toBeInstanceOf(MemoryProposalAccessDeniedError);
  await expect(memories.listProposals(testContext.alice)).resolves.toEqual([]);

  await testContext.close();
});

test("A Proposal cites only RLS-visible Observation evidence without making it Memory", async () => {
  const { agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const observations = createObservationModule(testContext.database);
  const visibleEpisode = await observations.record(agentActor, {
    kind: "conversation",
    observations: [{ kind: "message", content: "The owner prefers tea." }],
  });
  const hiddenEpisode = await observations.record(testContext.bob, {
    kind: "conversation",
    observations: [{ kind: "message", content: "Bob prefers coffee." }],
  });
  const visibleObservationId = visibleEpisode.observations[0].id;

  const proposal = await memories.propose(agentActor, {
    kind: "create",
    content: "The owner prefers tea.",
    evidenceObservationIds: [visibleObservationId],
  });

  expect(proposal).toMatchObject({
    evidenceMemoryIds: [],
    evidenceObservationIds: [visibleObservationId],
  });
  await expect(memories.list(testContext.alice)).resolves.toEqual([]);
  await expect(memories.listProposals(testContext.alice)).resolves.toMatchObject([
    { id: proposal.id, evidenceObservationIds: [visibleObservationId] },
  ]);
  await expect(
    memories.propose(agentActor, {
      kind: "create",
      content: "Attempted cross-owner synthesis",
      evidenceObservationIds: [hiddenEpisode.observations[0].id],
    }),
  ).rejects.toBeInstanceOf(MemoryProposalAccessDeniedError);
  await expect(observations.forget(testContext.alice, visibleEpisode.id)).resolves.toBe(true);
  await expect(memories.listProposals(testContext.alice)).resolves.toMatchObject([
    { id: proposal.id, evidenceObservationIds: [visibleObservationId] },
  ]);
  await expect(
    memories.reviewProposal(testContext.alice, proposal.id, "accept"),
  ).rejects.toBeInstanceOf(MemoryProposalReviewConflictError);

  await testContext.close();
});

test("A human accepts a Proposal while its cited Observation remains visible", async () => {
  const { agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const observations = createObservationModule(testContext.database);
  const episode = await observations.record(agentActor, {
    kind: "conversation",
    observations: [{ kind: "message", content: "The owner prefers tea." }],
  });
  const proposal = await memories.propose(agentActor, {
    kind: "create",
    content: "The owner prefers tea.",
    evidenceObservationIds: [episode.observations[0].id],
  });

  await expect(
    memories.reviewProposal(testContext.alice, proposal.id, "accept"),
  ).resolves.toMatchObject({
    proposal: {
      id: proposal.id,
      status: "accepted",
      evidenceObservationIds: [episode.observations[0].id],
    },
    memory: { content: "The owner prefers tea." },
  });

  await testContext.close();
});

test("Revoked write grant immediately blocks Agent proposals", async () => {
  const { access, agent, agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  await access.revokeAgentGrant(testContext.alice, agent.id);

  await expect(
    memories.propose(agentActor, { kind: "create", content: "Should not be proposed" }),
  ).rejects.toBeInstanceOf(MemoryProposalAccessDeniedError);

  await testContext.close();
});

test("A read-only sibling Agent cannot submit or inspect another Agent proposal", async () => {
  const { access, agent, agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const readAgent = await access.createAgent(testContext.alice, { name: "Read assistant" });
  await access.grantAgent(testContext.alice, readAgent.id, { permission: "read" });
  const readActor = { ...testContext.alice, agentId: readAgent.id };
  const proposal = await memories.propose(agentActor, {
    kind: "create",
    content: "Only the writing Agent submitted this",
  });

  await expect(
    memories.propose(readActor, { kind: "create", content: "Read-only suggestion" }),
  ).rejects.toBeInstanceOf(MemoryProposalAccessDeniedError);
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, readActor);
    await expect(
      transaction.execute(sql`SELECT id FROM memory_proposals WHERE id = ${proposal.id}`),
    ).resolves.toMatchObject({ rows: [] });
  });

  await access.revokeAgentGrant(testContext.alice, agent.id);
  await testContext.close();
});

test("Suspending the owner Membership blocks Agent submission and human review", async () => {
  const { agentActor, testContext } = await createWritingAgent();
  const memories = createMemoryModule(testContext.database);
  const proposal = await memories.propose(agentActor, {
    kind: "create",
    content: "Pending before Membership suspension",
  });
  await testContext.suspendMembership(testContext.alice);

  await expect(
    memories.propose(agentActor, { kind: "create", content: "Blocked after suspension" }),
  ).rejects.toBeInstanceOf(MemoryProposalAccessDeniedError);
  await expect(memories.listProposals(testContext.alice)).resolves.toEqual([]);
  await expect(
    memories.reviewProposal(testContext.alice, proposal.id, "accept"),
  ).resolves.toBeNull();

  await testContext.close();
});

test("Proposal lists stay scoped when one owner belongs to two Workspaces", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  await access.addMember(testContext.carol, testContext.alice.userId, { role: "member" });
  const researchAlice = {
    userId: testContext.alice.userId,
    workspaceId: testContext.carol.workspaceId,
  };
  const operationsProposal = await memories.propose(testContext.alice, {
    kind: "create",
    content: "Operations only",
  });
  const researchProposal = await memories.propose(researchAlice, {
    kind: "create",
    content: "Research only",
  });

  await expect(memories.listProposals(testContext.alice)).resolves.toMatchObject([
    { id: operationsProposal.id },
  ]);
  await expect(memories.listProposals(researchAlice)).resolves.toMatchObject([
    { id: researchProposal.id },
  ]);
  await expect(
    memories.reviewProposal(testContext.alice, researchProposal.id, "accept"),
  ).resolves.toBeNull();

  await testContext.close();
});
