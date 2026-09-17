import type { EmbeddingProvider, PostgresDatabase } from "@corespeed/lore-core";
import { expect, test, vi } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { mutationRequestHash } from "@/server/api/idempotency";
import { createAccessModule } from "@/server/auth/access";
import { createMemoryTestContext } from "../support/memory-context";

function embeddingProvider(): EmbeddingProvider {
  return {
    provider: "fixture",
    model: "host-boundary-v1",
    revision: "fixture-v1",
    dimensions: 1024,
    async embed(texts) {
      return texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)));
    },
  };
}

test("OSS denies read-only Agent mutations before disclosing the current Memory version", async () => {
  const context = await createMemoryTestContext();
  const access = createAccessModule(context.database);
  const memories = createMemoryModule(context.database);
  const memory = await memories.remember(context.alice, {
    content: "An owner-private deployment decision.",
    scope: "private",
  });
  const agent = await access.createAgentForWorkspace(context.alice, {
    name: "Read-only assistant",
    permission: "read",
  });
  const credential = await access.issueAgentCredential(context.alice, agent.id);
  const actor = await access.authenticateAgent(credential.token, context.alice.workspaceId);
  if (!actor) throw new Error("Agent authentication failed in fixture");
  await expect(memories.retrieve(actor, memory.id)).resolves.toEqual(memory);

  for (const expectedVersion of [memory.version, memory.version + 99]) {
    await expect(
      memories.update(
        actor,
        memory.id,
        { content: "Unauthorized replacement." },
        { expectedVersion },
      ),
    ).resolves.toBeNull();
    await expect(memories.forget(actor, memory.id, { expectedVersion })).resolves.toBe(false);
  }
  await expect(memories.retrieve(context.alice, memory.id)).resolves.toEqual(memory);
});

test("OSS rolls back Memory, idempotency and embedding jobs without notifying maintenance", async () => {
  const context = await createMemoryTestContext();
  const failure = new Error("Host transaction cannot commit");
  const database: PostgresDatabase = {
    transaction: (use) =>
      context.database.transaction(async (transaction) => {
        await use(transaction);
        throw failure;
      }),
  };
  const notify = vi.fn();
  const memories = createMemoryModule(database, {
    embeddingProvider: embeddingProvider(),
    maintenanceNotifier: { notify },
  });
  const input = { content: "This Memory must never commit." };
  const operation = "memory.create";

  await expect(
    memories.remember(context.alice, input, {
      idempotency: {
        key: "host-boundary-rollback",
        operation,
        requestHash: await mutationRequestHash({ operation, payload: input }),
      },
    }),
  ).rejects.toBe(failure);
  expect(notify).not.toHaveBeenCalled();
  const rows = await context.adminDatabase.transaction(async (transaction) => ({
    memories: (await transaction.query("SELECT id FROM memories")).rows,
    jobs: (await transaction.query("SELECT id FROM memory_embedding_jobs")).rows,
    replays: (await transaction.query("SELECT id FROM request_idempotency_records")).rows,
  }));
  expect(rows).toEqual({ memories: [], jobs: [], replays: [] });
});

test("OSS preserves wire identity and emits one post-commit notification across idempotent replay", async () => {
  const context = await createMemoryTestContext();
  let activeTransactions = 0;
  let committedTransactions = 0;
  const database: PostgresDatabase = {
    async transaction(use) {
      activeTransactions += 1;
      try {
        const result = await context.database.transaction(use);
        committedTransactions += 1;
        return result;
      } finally {
        activeTransactions -= 1;
      }
    },
  };
  const notifications: Array<{
    jobId: string;
    activeTransactions: number;
    committedTransactions: number;
  }> = [];
  const memories = createMemoryModule(database, {
    embeddingProvider: embeddingProvider(),
    maintenanceNotifier: {
      notify({ jobId }) {
        notifications.push({ jobId, activeTransactions, committedTransactions });
      },
    },
  });
  const input = { content: "A committed deployment decision.", metadata: { category: "decision" } };
  const operation = "memory.create";
  const options = {
    idempotency: {
      key: "host-boundary-replay",
      operation,
      requestHash: await mutationRequestHash({ operation, payload: input }),
    },
  };

  const first = await memories.remember(context.alice, input, options);
  const replay = await memories.remember(context.alice, input, options);

  expect(replay).toEqual(first);
  expect(first).toMatchObject({
    workspaceId: context.alice.workspaceId,
    ownerUserId: context.alice.userId,
    createdByAgentId: null,
    scope: "shared",
    version: 1,
    ...input,
  });
  expect(first).not.toHaveProperty("partitionId");
  expect(first).not.toHaveProperty("ownerId");
  expect(first).not.toHaveProperty("sourceId");
  expect(notifications).toEqual([
    { jobId: expect.any(String), activeTransactions: 0, committedTransactions: 1 },
  ]);
  await expect(
    context.adminDatabase.transaction((transaction) =>
      transaction.query("SELECT memory_id FROM memory_embedding_jobs"),
    ),
  ).resolves.toMatchObject({ rows: [{ memory_id: first.id }] });
});

test("OSS initializes every retrieval pass before visible evidence reaches feedback and reranking", async () => {
  const context = await createMemoryTestContext();
  const writer = createMemoryModule(context.database);
  const first = await writer.remember(context.alice, {
    content: "Alicevra's spouse is Bobnix.",
    metadata: { topic: "permitted" },
  });
  const second = await writer.remember(context.alice, {
    content: "Bobnix's employer is Acmequill.",
    metadata: { topic: "permitted" },
  });
  const third = await writer.remember(context.alice, {
    content: "Acmequill's headquarters are in Berlinora.",
    scope: "private",
    metadata: { topic: "permitted" },
  });
  for (const [actor, scope, content, topic] of [
    [context.bob, "private", "Alicevra spouse Bobnix employer Acmequill OWNER_SECRET", "permitted"],
    [
      context.carol,
      "shared",
      "Alicevra spouse Bobnix employer Acmequill WORKSPACE_SECRET",
      "permitted",
    ],
    [
      context.alice,
      "shared",
      "Alicevra spouse Bobnix employer Acmequill FILTER_SECRET",
      "excluded",
    ],
  ] as const) {
    await writer.remember(actor, { content, scope, metadata: { topic } });
  }

  const embeddedQueries: string[] = [];
  const rerankedDocuments: Array<{ id: string; text: string }> = [];
  const plan = vi.fn(async (_input: { query: string; maxQueries: number }) => ["Alicevra spouse"]);
  const provider = embeddingProvider();
  const memories = createMemoryModule(context.database, {
    embeddingProvider: {
      ...provider,
      async embed(texts, task) {
        if (task === "query") embeddedQueries.push(...texts);
        return provider.embed(texts, task);
      },
    },
    queryPlanningProvider: { plan },
    queryPlannerMaxQueries: 2,
    retrievalFeedbackQueries: 2,
    rerankingProvider: {
      async rerank({ documents }) {
        rerankedDocuments.push(...documents);
        return documents.map((document) => ({ documentId: document.id, score: 1 }));
      },
    },
  });
  const query = "Where is Alicevra's spouse's employer headquartered?";
  const results = await memories.search(context.alice, {
    query,
    metadataFilter: { topic: "permitted" },
    limit: 5,
  });

  expect(plan).toHaveBeenCalledExactlyOnceWith({ query, maxQueries: 1 });
  expect(embeddedQueries.length).toBeGreaterThan(2);
  expect(embeddedQueries.some((value) => value.includes("Bobnix"))).toBe(true);
  expect(results.map((result) => result.memory.id).sort()).toEqual(
    [first.id, second.id, third.id].sort(),
  );
  expect(rerankedDocuments.map((document) => document.id).sort()).toEqual(
    [first.id, second.id, third.id].sort(),
  );
  for (const secret of ["OWNER_SECRET", "WORKSPACE_SECRET", "FILTER_SECRET"]) {
    expect(JSON.stringify({ embeddedQueries, rerankedDocuments, results })).not.toContain(secret);
  }
  expect(results.every((result) => result.memory.workspaceId === context.alice.workspaceId)).toBe(
    true,
  );
});
