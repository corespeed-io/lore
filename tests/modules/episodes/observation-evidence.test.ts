import { LoreClient } from "@corespeed/lore-sdk";
import { expect, test } from "vitest";
import {
  createMemoryObservationEvidenceModule,
  MEMORY_OBSERVATION_EVIDENCE_LIMITS,
  MemoryObservationEvidenceCapacityError,
  MemoryObservationEvidenceValidationError,
} from "@/modules/episodes/observation-evidence";
import { createObservationModule } from "@/modules/episodes/service";
import { createMemoryModule } from "@/modules/memories/service";
import { createMemoryProposalsModule } from "@/modules/proposals/service";
import { createApi } from "@/server/api/app";
import type { ActorContext } from "@/server/auth/actor-context";
import { createAccessModule } from "../../support/access";
import { createMemoryTestContext } from "../../support/memory-context";

async function setup() {
  const context = await createMemoryTestContext();
  const observations = createObservationModule(context.database);
  const memories = createMemoryModule(context.database);
  const evidence = createMemoryObservationEvidenceModule(context.database);
  const record = (actor: ActorContext, scope: "private" | "shared", contents: string[]) =>
    observations.record(actor, {
      kind: "conversation",
      scope,
      observations: contents.map((content, index) => ({
        kind: "message" as const,
        content,
        observedAt: new Date(Date.UTC(2026, 9, 1 + index, 10)).toISOString(),
      })),
    });
  return { context, observations, memories, evidence, record };
}

const ids = (rows: readonly { observationId: string }[]) => rows.map((row) => row.observationId);

test("a citation is idempotent, lists oldest observed first, and reads within a budget", async () => {
  const { context, memories, evidence, record } = await setup();
  const episode = await record(context.alice, "private", [
    "First: the release moved to Friday.",
    "Second: the shop was called Blue Fern.",
    "Third: the chord progression was C, G, Am, F.",
  ]);
  const [first, second, third] = episode.observations.map((observation) => observation.id);
  if (!first || !second || !third) throw new Error("Expected three Observations");
  const facts = await memories.remember(context.alice, { content: "The user writes songs." });
  const plans = await memories.remember(context.alice, { content: "The release is on Friday." });

  const cited = await evidence.cite(context.alice, { memoryId: facts.id, observationId: third });
  expect(cited).toMatchObject({
    created: true,
    evidence: {
      memoryId: facts.id,
      observationId: third,
      episodeId: episode.id,
      observationOrdinal: 2,
      observationKind: "message",
      observedAt: "2026-10-03T10:00:00.000000Z",
      createdByUserId: context.alice.userId,
      createdByAgentId: null,
    },
  });
  expect(cited?.evidence.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  expect(await evidence.cite(context.alice, { memoryId: facts.id, observationId: third })).toEqual({
    ...cited,
    created: false,
  });
  await evidence.cite(context.alice, { memoryId: facts.id, observationId: first });
  await evidence.cite(context.alice, { memoryId: plans.id, observationId: first });
  expect(ids((await evidence.list(context.alice, { memoryId: facts.id })) ?? [])).toEqual([
    first,
    third,
  ]);

  // Memory order first, each Memory's sources oldest first, each Observation once.
  const contents = episode.observations.map((observation) => observation.content);
  const all = await evidence.read(context.alice, { memoryIds: [plans.id, facts.id] });
  expect(all.omittedObservationIds).toEqual([]);
  expect(all.sources).toEqual([
    expect.objectContaining({
      observationId: first,
      memoryIds: [plans.id, facts.id],
      content: contents[0],
      contentTruncated: false,
    }),
    expect.objectContaining({
      observationId: third,
      memoryIds: [facts.id],
      content: contents[2],
      contentTruncated: false,
    }),
  ]);

  const firstLength = Array.from(contents[0] ?? "").length;
  const cut = await evidence.read(context.alice, {
    memoryIds: [plans.id, facts.id],
    maximumCharacters: firstLength + 5,
  });
  expect(cut.sources.map((source) => [source.content, source.contentTruncated])).toEqual([
    [contents[0], false],
    [contents[2]?.slice(0, 5), true],
  ]);
  const omitted = await evidence.read(context.alice, {
    memoryIds: [plans.id, facts.id],
    maximumCharacters: firstLength,
  });
  expect(ids(omitted.sources)).toEqual([first]);
  expect(omitted.omittedObservationIds).toEqual([third]);

  expect(await evidence.remove(context.alice, { memoryId: facts.id, observationId: third })).toBe(
    true,
  );
  expect(await evidence.remove(context.alice, { memoryId: facts.id, observationId: third })).toBe(
    false,
  );
  expect(ids((await evidence.list(context.alice, { memoryId: facts.id })) ?? [])).toEqual([first]);
  expect(await evidence.read(context.alice, { memoryIds: [crypto.randomUUID()] })).toEqual({
    sources: [],
    omittedObservationIds: [],
  });
});

test("reads and keys are validated before any query", async () => {
  const { context, evidence } = await setup();
  const { maximumReadMemories, maximumReadCharacters } = MEMORY_OBSERVATION_EVIDENCE_LIMITS;
  for (const input of [
    { memoryIds: [] },
    { memoryIds: Array.from({ length: maximumReadMemories + 1 }, () => crypto.randomUUID()) },
    { memoryIds: ["not-a-uuid"] },
    { memoryIds: [crypto.randomUUID()], maximumCharacters: 0 },
    { memoryIds: [crypto.randomUUID()], maximumCharacters: maximumReadCharacters + 1 },
    { memoryIds: [crypto.randomUUID()], maximumCharacters: 1.5 },
  ]) {
    await expect(evidence.read(context.alice, input)).rejects.toBeInstanceOf(
      MemoryObservationEvidenceValidationError,
    );
  }
  await expect(
    evidence.cite(context.alice, { memoryId: "nope", observationId: crypto.randomUUID() }),
  ).rejects.toBeInstanceOf(MemoryObservationEvidenceValidationError);
});

test("both sides' visibility decides every read, and write authority decides every change", async () => {
  const { context, memories, evidence, record, observations } = await setup();
  const privateEpisode = await record(context.alice, "private", ["Alice's private note."]);
  const sharedEpisode = await record(context.alice, "shared", ["The team chose Postgres."]);
  const privateObservation = privateEpisode.observations[0]?.id ?? "";
  const sharedObservation = sharedEpisode.observations[0]?.id ?? "";
  const shared = await memories.remember(context.alice, {
    content: "The team uses Postgres.",
    scope: "shared",
  });
  for (const observationId of [privateObservation, sharedObservation]) {
    await evidence.cite(context.alice, { memoryId: shared.id, observationId });
  }

  // A co-member sees the shared Memory but never Alice's private Observation, not even its id.
  expect(ids((await evidence.list(context.bob, { memoryId: shared.id })) ?? [])).toEqual([
    sharedObservation,
  ]);
  expect(ids((await evidence.read(context.bob, { memoryIds: [shared.id] })).sources)).toEqual([
    sharedObservation,
  ]);
  // Bob may not change Alice's Memory, and may not cite what he cannot see.
  expect(
    await evidence.cite(context.bob, { memoryId: shared.id, observationId: sharedObservation }),
  ).toBeNull();
  expect(
    await evidence.remove(context.bob, { memoryId: shared.id, observationId: sharedObservation }),
  ).toBe(false);
  const bobs = await memories.remember(context.bob, { content: "Bob's summary.", scope: "shared" });
  expect(
    await evidence.cite(context.bob, { memoryId: bobs.id, observationId: privateObservation }),
  ).toBeNull();
  expect(
    await evidence.cite(context.bob, { memoryId: bobs.id, observationId: sharedObservation }),
  ).toMatchObject({ created: true });

  // Another Workspace sees nothing and can cite nothing.
  expect(await evidence.list(context.carol, { memoryId: shared.id })).toBeNull();
  expect((await evidence.read(context.carol, { memoryIds: [shared.id, bobs.id] })).sources).toEqual(
    [],
  );
  const carols = await memories.remember(context.carol, { content: "Carol's Memory." });
  expect(
    await evidence.cite(context.carol, { memoryId: carols.id, observationId: sharedObservation }),
  ).toBeNull();

  // An Agent reads with a read grant, cites only with a write grant, and records itself.
  const access = createAccessModule(context.database);
  const reader = await access.createAgent(context.alice, { name: "Source reader" });
  await access.grantAgent(context.alice, reader.id, { permission: "read" });
  const readingAgent = { ...context.alice, agentId: reader.id };
  expect(ids((await evidence.list(readingAgent, { memoryId: shared.id })) ?? [])).toHaveLength(2);
  // Even a citation that already exists needs write authority to cite.
  expect(
    await evidence.cite(readingAgent, { memoryId: shared.id, observationId: sharedObservation }),
  ).toBeNull();
  const writer = await access.createAgent(context.alice, { name: "Source writer" });
  await access.grantAgent(context.alice, writer.id, { permission: "write" });
  const writingAgent = { ...context.alice, agentId: writer.id };
  const own = await memories.remember(context.alice, { content: "Alice's private fact." });
  expect(
    await evidence.cite(readingAgent, { memoryId: own.id, observationId: privateObservation }),
  ).toBeNull();
  expect(
    await evidence.cite(writingAgent, { memoryId: own.id, observationId: privateObservation }),
  ).toMatchObject({ created: true, evidence: { createdByAgentId: writer.id } });
  await access.revokeAgentGrant(context.alice, reader.id);
  expect(await evidence.list(readingAgent, { memoryId: shared.id })).toBeNull();
  expect((await evidence.read(readingAgent, { memoryIds: [shared.id] })).sources).toEqual([]);

  // A scope change takes effect at once and rewrites nothing.
  await memories.update(
    context.alice,
    shared.id,
    { scope: "private" },
    { expectedVersion: shared.version },
  );
  expect(await evidence.list(context.bob, { memoryId: shared.id })).toBeNull();
  expect(ids((await evidence.list(context.alice, { memoryId: shared.id })) ?? [])).toHaveLength(2);

  // A suspended member sees nothing.
  await context.suspendMembership(context.bob);
  expect(await evidence.list(context.bob, { memoryId: bobs.id })).toBeNull();

  // Forgetting an Episode removes its citations; forgetting a Memory removes its own.
  expect(await observations.forget(context.alice, sharedEpisode.id)).toBe(true);
  expect(ids((await evidence.list(context.alice, { memoryId: shared.id })) ?? [])).toEqual([
    privateObservation,
  ]);
  const current = await memories.retrieve(context.alice, shared.id);
  expect(
    await memories.forget(context.alice, shared.id, { expectedVersion: current?.version ?? 0 }),
  ).toBe(true);
  const remaining = await context.adminDatabase.transaction((transaction) =>
    transaction.query<{ memory_id: string }>(
      "SELECT memory_id FROM memory_observation_evidence ORDER BY memory_id",
    ),
  );
  expect(remaining.rows.map((row) => row.memory_id)).toEqual([own.id]);
});

test("a Memory cites at most the bound, and the request role can never rewrite a citation", async () => {
  const { context, memories, evidence, record } = await setup();
  const { maximumObservationsPerMemory } = MEMORY_OBSERVATION_EVIDENCE_LIMITS;
  const episode = await record(
    context.alice,
    "private",
    Array.from({ length: maximumObservationsPerMemory + 1 }, (_, index) => `Turn ${index}.`),
  );
  const memory = await memories.remember(context.alice, { content: "A long conversation." });
  const [extra, ...bounded] = episode.observations.map((observation) => observation.id).reverse();
  for (const observationId of bounded) {
    await evidence.cite(context.alice, { memoryId: memory.id, observationId });
  }
  await expect(
    evidence.cite(context.alice, { memoryId: memory.id, observationId: extra ?? "" }),
  ).rejects.toBeInstanceOf(MemoryObservationEvidenceCapacityError);
  // Repeating a citation it already holds is not a new one.
  await expect(
    evidence.cite(context.alice, { memoryId: memory.id, observationId: bounded[0] ?? "" }),
  ).resolves.toMatchObject({ created: false });

  const privileges = await context.adminDatabase.transaction((transaction) =>
    transaction.query<{ privilege: string; granted: boolean }>(
      `SELECT privilege, has_table_privilege('lore_app', 'memory_observation_evidence', privilege) AS granted
       FROM unnest(ARRAY['SELECT', 'INSERT', 'DELETE', 'UPDATE']) AS privilege`,
    ),
  );
  expect(Object.fromEntries(privileges.rows.map((row) => [row.privilege, row.granted]))).toEqual({
    SELECT: true,
    INSERT: true,
    DELETE: true,
    UPDATE: false,
  });
  // A citation forged for another User is refused by the INSERT policy.
  await expect(
    context.database.transaction(async (transaction) => {
      await transaction.query(
        `SELECT set_config('lore.workspace_id', $1, true), set_config('lore.user_id', $2, true),
                set_config('lore.agent_id', '', true)`,
        [context.alice.workspaceId, context.alice.userId],
      );
      await transaction.query(
        `INSERT INTO memory_observation_evidence
           (workspace_id, memory_id, observation_id, created_by_user_id)
         VALUES ($1, $2, $3, $4)`,
        [context.alice.workspaceId, memory.id, extra, context.bob.userId],
      );
    }),
  ).rejects.toThrow(/row-level security/);
});

test("accepting a Proposal copies its surviving Observation evidence onto the Memory", async () => {
  const { context, memories, evidence, record, observations } = await setup();
  const proposals = createMemoryProposalsModule(context.database);
  const kept = await record(context.alice, "private", ["Kept source.", "Second kept source."]);
  const lost = await record(context.alice, "private", ["Source forgotten before review."]);
  const [keptFirst, keptSecond] = kept.observations.map((observation) => observation.id);
  const lostObservation = lost.observations[0]?.id ?? "";

  const created = await proposals.propose(context.alice, {
    kind: "create",
    content: "A fact taken from two sources.",
    evidenceObservationIds: [keptFirst ?? "", keptSecond ?? ""],
  });
  const accepted = await proposals.reviewProposal(context.alice, created.id, "accept");
  if (!accepted?.memory) throw new Error("Expected the accepted Memory");
  const copied = (await evidence.list(context.alice, { memoryId: accepted.memory.id })) ?? [];
  expect(ids(copied)).toEqual([keptFirst, keptSecond]);
  expect(copied[0]).toMatchObject({
    createdByUserId: context.alice.userId,
    createdByAgentId: null,
  });

  // A rejected Proposal copies nothing.
  const rejected = await proposals.propose(context.alice, {
    kind: "create",
    content: "Never accepted.",
    evidenceObservationIds: [keptFirst ?? ""],
  });
  const review = await proposals.reviewProposal(context.alice, rejected.id, "reject");
  expect(review?.memory).toBeNull();

  // An update keeps the target's citations and adds the Proposal's.
  const target = await memories.remember(context.alice, { content: "Before the update." });
  await evidence.cite(context.alice, { memoryId: target.id, observationId: keptSecond ?? "" });
  const update = await proposals.propose(context.alice, {
    kind: "update",
    targetMemoryId: target.id,
    expectedVersion: target.version,
    content: "After the update.",
    evidenceObservationIds: [keptFirst ?? "", keptSecond ?? ""],
  });
  const updated = await proposals.reviewProposal(context.alice, update.id, "accept");
  expect(updated?.memory?.id).toBe(target.id);
  expect(ids((await evidence.list(context.alice, { memoryId: target.id })) ?? [])).toEqual([
    keptFirst,
    keptSecond,
  ]);

  // Acceptance requires every cited Observation to be visible, as before this table.
  const stale = await proposals.propose(context.alice, {
    kind: "create",
    content: "Its source is gone.",
    evidenceObservationIds: [lostObservation],
  });
  await observations.forget(context.alice, lost.id);
  await expect(proposals.reviewProposal(context.alice, stale.id, "accept")).rejects.toThrow(
    "Observation evidence is no longer available for review",
  );
});

test("acceptance that would pass the per-Memory bound fails and leaves the Proposal pending", async () => {
  const { context, memories, evidence, record } = await setup();
  const proposals = createMemoryProposalsModule(context.database);
  const { maximumObservationsPerMemory } = MEMORY_OBSERVATION_EVIDENCE_LIMITS;
  const episode = await record(
    context.alice,
    "private",
    Array.from({ length: maximumObservationsPerMemory + 1 }, (_, index) => `Turn ${index}.`),
  );
  const observationIds = episode.observations.map((observation) => observation.id);
  const target = await memories.remember(context.alice, { content: "Fully cited." });
  for (const observationId of observationIds.slice(0, maximumObservationsPerMemory)) {
    await evidence.cite(context.alice, { memoryId: target.id, observationId });
  }
  const update = await proposals.propose(context.alice, {
    kind: "update",
    targetMemoryId: target.id,
    expectedVersion: target.version,
    content: "One source too many.",
    evidenceObservationIds: [observationIds[maximumObservationsPerMemory] ?? ""],
  });
  await expect(proposals.reviewProposal(context.alice, update.id, "accept")).rejects.toBeInstanceOf(
    MemoryObservationEvidenceCapacityError,
  );
  const pending = await proposals.listProposals(context.alice, { status: "pending" });
  expect(pending.map((proposal) => proposal.id)).toContain(update.id);
  expect((await memories.retrieve(context.alice, target.id))?.content).toBe("Fully cited.");
});

test("SDK → HTTP cites, lists, reads, and removes with natural-key status codes", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "observation-evidence-http";
  try {
    const context = await createMemoryTestContext();
    const app = createApi({
      database: () => context.database,
      memoryOptions: () => ({}),
      codeRepositories: () => ({}),
    });
    const client = new LoreClient({
      baseUrl: "http://lore.local",
      fetch: async (input, init) => app.request(new Request(input, init)),
    });
    const workspace = client.workspace((await client.createWorkspace("Sources")).id);
    const episode = await workspace.recordEpisode({
      kind: "conversation",
      observations: [{ kind: "message", content: "The assistant suggested C, G, Am, F." }],
    });
    const observationId = episode.observations[0]?.id ?? "";
    const memory = await workspace.remember({ content: "The user is writing a song." });

    const cited = await workspace.citeMemoryObservationEvidence({
      memoryId: memory.id,
      observationId,
    });
    expect(cited).toMatchObject({
      created: true,
      evidence: { memoryId: memory.id, observationId },
    });
    await expect(
      workspace.citeMemoryObservationEvidence({ memoryId: memory.id, observationId }),
    ).resolves.toMatchObject({ created: false });
    expect(
      (await workspace.listMemoryObservationEvidence(memory.id)).map((row) => row.observationId),
    ).toEqual([observationId]);
    await expect(
      workspace.readMemorySources({ memoryIds: [memory.id], maximumCharacters: 13 }),
    ).resolves.toEqual({
      sources: [
        expect.objectContaining({
          observationId,
          memoryIds: [memory.id],
          content: "The assistant",
          contentTruncated: true,
        }),
      ],
      omittedObservationIds: [],
    });
    await expect(workspace.readMemorySources({ memoryIds: [] })).rejects.toThrow("memoryIds");

    const headers = { "x-lore-workspace-id": workspace.workspaceId };
    const missing = crypto.randomUUID();
    for (const [method, path, body] of [
      ["GET", `/api/v1/memories/${missing}/observation-evidence`, undefined],
      ["PUT", `/api/v1/memories/${missing}/observation-evidence/${observationId}`, undefined],
      ["PUT", `/api/v1/memories/${memory.id}/observation-evidence/${missing}`, undefined],
      ["DELETE", `/api/v1/memories/${memory.id}/observation-evidence/${missing}`, undefined],
    ] as const) {
      const response = await app.request(`http://lore.local${path}`, { method, headers, body });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    for (const body of [
      { memoryIds: [memory.id], extra: true },
      { memoryIds: memory.id },
      { memoryIds: [1] },
      { memoryIds: [memory.id], maximumCharacters: "12" },
      { memoryIds: [memory.id], maximumCharacters: 0 },
    ]) {
      const response = await app.request(
        "http://lore.local/api/v1/memories/observation-evidence/read",
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const badKey = await app.request(
      `http://lore.local/api/v1/memories/${memory.id}/observation-evidence/not-a-uuid`,
      { method: "PUT", headers },
    );
    expect(badKey.status).toBe(400);

    await workspace.removeMemoryObservationEvidence({ memoryId: memory.id, observationId });
    await expect(
      workspace.removeMemoryObservationEvidence({ memoryId: memory.id, observationId }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await workspace.listMemoryObservationEvidence(memory.id)).toEqual([]);
  } finally {
    for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"])
      delete process.env[key];
  }
});
