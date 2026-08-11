import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import { installActorContext } from "@/lib/actor-context";
import { createMemoryMaintenanceModule } from "@/lib/maintenance";
import {
  type ActorContext,
  createMemoryModule,
  type EmbeddingTask,
  MemoryAccessDeniedError,
} from "@/lib/memory";
import { createMemoryTestContext, type MemoryTestContext } from "./support/memory-context";

async function replaceMemoryChunks(
  testContext: MemoryTestContext,
  actor: ActorContext,
  memoryId: string,
  chunks: string[],
): Promise<void> {
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, actor);
    await transaction.execute(
      sql`DELETE FROM memory_chunks WHERE workspace_id = ${actor.workspaceId} AND memory_id = ${memoryId}`,
    );
    for (const [ordinal, content] of chunks.entries()) {
      await transaction.execute(sql`INSERT INTO memory_chunks (id, workspace_id, memory_id, ordinal, content)
         VALUES (${crypto.randomUUID()}, ${actor.workspaceId}, ${memoryId}, ${ordinal}, ${content})`);
    }
  });
}

test("Memory owner can remember and retrieve a private Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);

  const created = await memories.remember(testContext.alice, {
    content: "The launch checklist lives in the operations workspace.",
    scope: "private",
  });

  await expect(memories.retrieve(testContext.alice, created.id)).resolves.toMatchObject({
    id: created.id,
    workspaceId: testContext.alice.workspaceId,
    ownerUserId: testContext.alice.userId,
    createdByAgentId: null,
    scope: "private",
    content: "The launch checklist lives in the operations workspace.",
  });

  await testContext.close();
});

test("Workspace member cannot retrieve another User's private Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Alice's private launch concern.",
    scope: "private",
  });

  await expect(memories.retrieve(testContext.bob, created.id)).resolves.toBeNull();

  await testContext.close();
});

test("Workspace member can retrieve another User's shared Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "The launch date is September 8.",
  });

  await expect(memories.retrieve(testContext.bob, created.id)).resolves.toMatchObject({
    id: created.id,
    ownerUserId: testContext.alice.userId,
    scope: "shared",
  });

  await testContext.close();
});

test("User in another Workspace cannot retrieve a shared Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Operations workspace launch plan.",
  });

  await expect(memories.retrieve(testContext.carol, created.id)).resolves.toBeNull();

  await testContext.close();
});

test("Only the Memory owner can update content or scope", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Draft launch date.",
  });

  await expect(
    memories.update(testContext.bob, created.id, { content: "Bob's replacement." }),
  ).resolves.toBeNull();
  const updated = await memories.update(testContext.alice, created.id, {
    content: "Confirmed launch date.",
    scope: "private",
  });

  expect(updated).toMatchObject({
    content: "Confirmed launch date.",
    scope: "private",
    version: 2,
  });
  await expect(memories.retrieve(testContext.bob, created.id)).resolves.toBeNull();

  await testContext.close();
});

test("Only the Memory owner can forget a Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Temporary launch note.",
  });

  await expect(memories.forget(testContext.bob, created.id)).resolves.toBe(false);
  await expect(memories.forget(testContext.alice, created.id)).resolves.toBe(true);
  await expect(memories.retrieve(testContext.alice, created.id)).resolves.toBeNull();
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await expect(
      transaction.execute(sql`SELECT id FROM memory_chunks WHERE memory_id = ${created.id}`),
    ).resolves.toMatchObject({ rows: [] });
  });
  await expect(
    memories.search(testContext.alice, { query: "Temporary", limit: 10 }),
  ).resolves.toEqual([]);

  await testContext.close();
});

test("Suspended Membership immediately removes access to shared Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Workspace incident review.",
  });
  await expect(memories.retrieve(testContext.bob, created.id)).resolves.not.toBeNull();

  await testContext.suspendMembership(testContext.bob);

  await expect(memories.retrieve(testContext.bob, created.id)).resolves.toBeNull();
  await testContext.close();
});

test("User's permitted Agents share private Memory with Agent provenance", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);

  const writer = await access.createAgent(testContext.alice, { name: "Writer" });
  await access.grantAgent(testContext.alice, writer.id, { permission: "write" });
  const writerCredential = await access.issueAgentCredential(testContext.alice, writer.id);
  const writerActor = await access.authenticateAgent(
    writerCredential.token,
    testContext.alice.workspaceId,
  );

  const reader = await access.createAgent(testContext.alice, { name: "Reader" });
  await access.grantAgent(testContext.alice, reader.id, { permission: "read" });
  const readerCredential = await access.issueAgentCredential(testContext.alice, reader.id);
  const readerActor = await access.authenticateAgent(
    readerCredential.token,
    testContext.alice.workspaceId,
  );
  if (!writerActor || !readerActor) throw new Error("Agent authentication failed in fixture");

  const created = await memories.remember(writerActor, {
    content: "Alice's private preference.",
    scope: "private",
  });

  expect(created.createdByAgentId).toBe(writer.id);
  await expect(memories.retrieve(readerActor, created.id)).resolves.toMatchObject({
    id: created.id,
    ownerUserId: testContext.alice.userId,
    createdByAgentId: writer.id,
    scope: "private",
  });
  await expect(memories.retrieve(testContext.bob, created.id)).resolves.toBeNull();

  await testContext.close();
});

test("Read-only Agent cannot create Memory", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  const reader = await access.createAgent(testContext.alice, { name: "Reader" });
  await access.grantAgent(testContext.alice, reader.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, reader.id);
  const readerActor = await access.authenticateAgent(
    credential.token,
    testContext.alice.workspaceId,
  );
  if (!readerActor) throw new Error("Agent authentication failed in fixture");

  await expect(
    memories.remember(readerActor, { content: "Unauthorized write." }),
  ).rejects.toBeInstanceOf(MemoryAccessDeniedError);

  await testContext.close();
});

test("Revoked Agent Grant blocks an already-authenticated Actor Context", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Private operating preference.",
    scope: "private",
  });
  const reader = await access.createAgent(testContext.alice, { name: "Reader" });
  await access.grantAgent(testContext.alice, reader.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, reader.id);
  const readerActor = await access.authenticateAgent(
    credential.token,
    testContext.alice.workspaceId,
  );
  if (!readerActor) throw new Error("Agent authentication failed in fixture");
  await expect(memories.retrieve(readerActor, created.id)).resolves.not.toBeNull();

  await access.revokeAgentGrant(testContext.alice, reader.id);

  await expect(memories.retrieve(readerActor, created.id)).resolves.toBeNull();
  await testContext.close();
});

test("Search ranks only Memories visible inside the Actor's Workspace", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const shared = await memories.remember(testContext.alice, {
    content: "Orbital launch checklist for the shared mission.",
  });
  await memories.remember(testContext.alice, {
    content: "Private orbital launch concern from Alice.",
    scope: "private",
  });
  await memories.remember(testContext.carol, {
    content: "Research workspace orbital launch notes.",
  });

  const results = await memories.search(testContext.bob, { query: "orbital launch", limit: 10 });

  expect(results.map((result) => result.memory.id)).toEqual([shared.id]);
  expect(results[0].evidence).toContain("Orbital launch checklist");
  await testContext.close();
});

test("Updating Memory content replaces stale search chunks", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Provisional apricot launch code.",
  });

  await memories.update(testContext.alice, created.id, {
    content: "Confirmed blueberry launch code.",
  });

  await expect(
    memories.search(testContext.alice, { query: "apricot", limit: 10 }),
  ).resolves.toEqual([]);
  await expect(
    memories.search(testContext.alice, { query: "blueberry", limit: 10 }),
  ).resolves.toMatchObject([{ memory: { id: created.id } }]);
  await testContext.close();
});

test("Changing Memory scope invalidates and rebuilds derived chunks", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "A shared launch checklist becomes private.",
  });
  const chunkIds = async () =>
    testContext.database.transaction(async (transaction) => {
      await installActorContext(transaction, testContext.alice);
      const result = await transaction.execute<{ id: string }>(
        sql`SELECT id FROM memory_chunks WHERE memory_id = ${created.id} ORDER BY ordinal`,
      );
      return result.rows.map((row) => row.id);
    });
  const before = await chunkIds();

  await memories.update(testContext.alice, created.id, { scope: "private" });

  const after = await chunkIds();
  expect(after).toHaveLength(before.length);
  expect(after).not.toEqual(before);
  await expect(memories.retrieve(testContext.bob, created.id)).resolves.toBeNull();
  await testContext.close();
});

test("RLS denies direct access to another User's private Memory chunks", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const created = await memories.remember(testContext.alice, {
    content: "Alice private evidence text.",
    scope: "private",
  });

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    await expect(
      transaction.execute(
        sql`SELECT id, content FROM memory_chunks WHERE memory_id = ${created.id}`,
      ),
    ).resolves.toMatchObject({ rows: [] });
  });
});

test("Lexical search stems English questions without weakening multilingual indexing", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const expected = await memories.remember(testContext.alice, {
    content: "I graduated with a degree in Business Administration.",
  });
  await memories.remember(testContext.alice, {
    content: "The graduation ceremony is scheduled for next month.",
  });

  const results = await memories.search(testContext.bob, {
    query: "What degree did I graduate with?",
    limit: 5,
  });

  expect(results.map((result) => result.memory.id)).toContain(expected.id);
  await testContext.close();
});

test("Relaxed lexical search gives proper-name terms more weight than common matches", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const expected = await memories.remember(testContext.alice, {
    content: "Petrela stood beside the river Deabolis.",
  });
  for (let index = 0; index < 12; index += 1) {
    await memories.remember(testContext.alice, {
      content: `A common river settlement was located beside district ${index}.`,
    });
  }

  const results = await memories.search(testContext.bob, {
    query: "What river was Petrela located by?",
    limit: 1,
  });

  expect(results.map((result) => result.memory.id)).toEqual([expected.id]);
  await testContext.close();
});

test("Lexical search recalls evidence for separate concepts in a multi-part question", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const first = await memories.remember(testContext.alice, {
    content: "I visited the Museum of Modern Art for a guided tour last Sunday.",
  });
  const second = await memories.remember(testContext.alice, {
    content: "I attended the Ancient Civilizations exhibit at the Metropolitan Museum today.",
  });
  await memories.remember(testContext.alice, {
    content: "The neighborhood art supply shop closes early on Sundays.",
  });

  const results = await memories.search(testContext.bob, {
    query:
      "How many days passed between my Museum of Modern Art visit and the Ancient Civilizations exhibit at the Metropolitan Museum?",
    limit: 5,
  });

  expect(results.map((result) => result.memory.id)).toEqual(
    expect.arrayContaining([first.id, second.id]),
  );
  await testContext.close();
});

test("Search breaks equal relevance scores by Memory recency", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const older = await memories.remember(testContext.alice, {
    content: "Atlas status codename amber.",
  });
  const newer = await memories.remember(testContext.alice, {
    content: "Atlas status codename amber.",
  });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.execute(
      sql`UPDATE memories SET updated_at = ${"2025-01-01T00:00:00.000Z"} WHERE id = ${older.id}`,
    );
    await transaction.execute(
      sql`UPDATE memories SET updated_at = ${"2026-01-01T00:00:00.000Z"} WHERE id = ${newer.id}`,
    );
  });

  const results = await memories.search(testContext.alice, {
    query: "Atlas status codename amber",
    limit: 2,
  });

  expect(results.map((result) => result.memory.id)).toEqual([newer.id, older.id]);
  await testContext.close();
});

test("Search prefers the later chunk when relevance ties", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const expected = await memories.remember(testContext.alice, {
    content: "0. The capital is Paris.\n1. The capital is Rome.",
  });
  await replaceMemoryChunks(testContext, testContext.alice, expected.id, [
    "0. The capital is Paris.",
    "1. The capital is Rome.",
  ]);

  const results = await memories.search(testContext.alice, {
    query: "What is the capital?",
    limit: 1,
  });

  expect(results).toMatchObject([
    { memory: { id: expected.id }, evidence: "1. The capital is Rome." },
  ]);
  await testContext.close();
});

test("Search can aggregate multiple top evidence chunks from one Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const memory = await memories.remember(testContext.alice, {
    content: "0. The capital is Paris.\n1. The capital is Rome.\n2. The weather is sunny.",
  });
  await replaceMemoryChunks(testContext, testContext.alice, memory.id, [
    "0. The capital is Paris.",
    "1. The capital is Rome.",
    "2. The weather is sunny.",
  ]);

  const results = await createMemoryModule(testContext.database, {
    evidenceTopChunks: 2,
  }).search(testContext.alice, {
    query: "What is the capital?",
    limit: 1,
  });

  expect(results[0]?.evidence).toBe("0. The capital is Paris.\n1. The capital is Rome.");
  await testContext.close();
});

test("Entity aliases retain specific names while dropping question-openers", async () => {
  const testContext = await createMemoryTestContext();
  const result = await testContext.adminDatabase.transaction((transaction) =>
    transaction.execute<{ aliases: string[] }>(
      sql`SELECT lore.extract_entity_aliases(${"From which source was the Duchy of Normandy's Qwen3-Reranker record quoted?"}) AS aliases`,
    ),
  );

  expect(result.rows[0]?.aliases).toEqual([
    "duchy of normandy's qwen3-reranker",
    "qwen3-reranker",
    "normandy's",
    "duchy",
  ]);
  await testContext.close();
});

test("Optional entity alias recall recovers an exact entity when relation wording diverges", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const expected = await memories.remember(testContext.alice, {
    content: "Zephyrquux reports to Ada Lovelace.",
  });

  await expect(
    memories.search(testContext.alice, { query: "Who mentors Zephyrquux?", limit: 5 }),
  ).resolves.toEqual([]);

  const results = await createMemoryModule(testContext.database, {
    entityAliasRecall: true,
  }).search(testContext.alice, {
    query: "Who mentors Zephyrquux?",
    limit: 5,
  });

  expect(results).toMatchObject([
    { memory: { id: expected.id }, evidence: "Zephyrquux reports to Ada Lovelace." },
  ]);
  await testContext.close();
});

test("Entity alias recall cannot expose another User's private Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const privateMemory = await memories.remember(testContext.bob, {
    content: "Zephyrquux reports to Bob's private contact.",
    scope: "private",
  });
  const entityRecall = createMemoryModule(testContext.database, { entityAliasRecall: true });

  await expect(
    entityRecall.search(testContext.alice, { query: "Who mentors Zephyrquux?", limit: 5 }),
  ).resolves.toEqual([]);
  await expect(
    entityRecall.search(testContext.bob, { query: "Who mentors Zephyrquux?", limit: 5 }),
  ).resolves.toMatchObject([{ memory: { id: privateMemory.id } }]);

  await testContext.close();
});

test("Evidence expansion returns a whole small Memory when its bounded budget covers it", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const content = [
    "0. Atlas status is red.",
    "1. Atlas owner is Priya.",
    "2. Atlas region is west.",
    "3. Atlas status is green.",
    "4. Atlas deadline is Friday.",
    "5. Atlas reviewer is Lin.",
  ].join("\n");
  const memory = await memories.remember(testContext.alice, { content });
  await replaceMemoryChunks(testContext, testContext.alice, memory.id, content.split("\n"));

  const results = await createMemoryModule(testContext.database, {
    evidenceNeighborChunks: 1,
    evidenceTopChunks: 2,
  }).search(testContext.alice, {
    query: "Atlas status",
    limit: 1,
  });

  expect(results[0]?.evidence).toBe(content);
  await testContext.close();
});

test("Optional temporal rank fusion can prefer newer relevant Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const older = await memories.remember(testContext.alice, {
    content:
      "Atlas status codename amber. Atlas status codename amber. Atlas status codename amber.",
  });
  const newer = await memories.remember(testContext.alice, {
    content: "Atlas status is now green.",
  });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.execute(
      sql`UPDATE memories SET updated_at = ${"2025-01-01T00:00:00.000Z"} WHERE id = ${older.id}`,
    );
    await transaction.execute(
      sql`UPDATE memories SET updated_at = ${"2026-01-01T00:00:00.000Z"} WHERE id = ${newer.id}`,
    );
  });

  const baseline = await memories.search(testContext.alice, {
    query: "Atlas status codename amber",
    limit: 2,
  });
  const temporal = await createMemoryModule(testContext.database, {
    rerankCandidateLimit: 2,
    retrievalRecencyWeight: 1,
  }).search(testContext.alice, {
    query: "Atlas status codename amber",
    limit: 1,
  });

  expect(baseline[0]?.memory.id).toBe(older.id);
  expect(temporal[0]?.memory.id).toBe(newer.id);
  await testContext.close();
});

test("Search can include adjacent chunks around the matching evidence", async () => {
  const testContext = await createMemoryTestContext();
  const content = `${"x".repeat(1_201)} uniqueanchor ${"y".repeat(1_201)}`;
  await createMemoryModule(testContext.database).remember(testContext.alice, { content });
  const exactEvidence = await createMemoryModule(testContext.database, {
    evidenceNeighborChunks: 0,
  }).search(testContext.bob, { query: "uniqueanchor", limit: 1 });
  const contextualEvidence = await createMemoryModule(testContext.database, {
    evidenceNeighborChunks: 1,
  }).search(testContext.bob, { query: "uniqueanchor", limit: 1 });

  expect(exactEvidence[0]?.evidence).toBe("uniqueanchor");
  expect(contextualEvidence[0]?.evidence).toContain(`uniqueanchor\n${"y".repeat(1_200)}`);
  await testContext.close();
});

test("Scope and time filters constrain candidates before ranking", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const oldShared = await memories.remember(testContext.alice, {
    content: "Atlas deployment status was red in the old report.",
  });
  const currentShared = await memories.remember(testContext.alice, {
    content: "Atlas deployment status is green in the current report.",
  });
  const currentPrivate = await memories.remember(testContext.alice, {
    content: "Atlas deployment status has a private rollback credential.",
    scope: "private",
  });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.execute(
      sql`UPDATE memories SET updated_at = ${"2025-01-01T00:00:00.000Z"} WHERE id = ${oldShared.id}`,
    );
    await transaction.execute(
      sql`UPDATE memories SET updated_at = ${"2026-01-01T00:00:00.000Z"} WHERE id = ${currentShared.id}`,
    );
    await transaction.execute(
      sql`UPDATE memories SET updated_at = ${"2026-01-02T00:00:00.000Z"} WHERE id = ${currentPrivate.id}`,
    );
  });

  const sharedResults = await memories.search(testContext.alice, {
    query: "Atlas deployment status",
    scope: "shared",
    updatedAfter: "2025-12-01T00:00:00.000Z",
    updatedBefore: "2026-01-02T00:00:00.000Z",
    limit: 10,
  });
  const privateResults = await memories.list(testContext.alice, {
    scope: "private",
    updatedAfter: "2026-01-01T12:00:00.000Z",
    limit: 10,
  });

  expect(sharedResults.map((result) => result.memory.id)).toEqual([currentShared.id]);
  expect(privateResults.map((memory) => memory.id)).toEqual([currentPrivate.id]);
  await testContext.close();
});

test("Metadata containment filters candidates before ranking without weakening RLS", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const expected = await memories.remember(testContext.alice, {
    content: "The V2 trajectory shows the Reports module before Problems.",
    scope: "private",
    metadata: { benchmark: "longmemeval-v2", questionIds: ["q1", "q2"] },
  });
  await memories.remember(testContext.alice, {
    content: "The V2 trajectory mentions Reports but belongs to another question.",
    scope: "private",
    metadata: { benchmark: "longmemeval-v2", questionIds: ["q3"] },
  });
  const forbidden = await memories.remember(testContext.bob, {
    content: "The private V2 answer tripwire says Reports then Problems.",
    scope: "private",
    metadata: { benchmark: "longmemeval-v2", questionIds: ["q1"] },
  });
  const metadataFilter = { benchmark: "longmemeval-v2", questionIds: ["q1"] };

  const searchResults = await memories.search(testContext.alice, {
    query: "Reports Problems",
    metadataFilter,
    limit: 10,
  });
  const listResults = await memories.list(testContext.alice, {
    metadataFilter,
    limit: 10,
  });

  expect(searchResults.map((result) => result.memory.id)).toEqual([expected.id]);
  expect(listResults.map((memory) => memory.id)).toEqual([expected.id]);
  expect(searchResults.map((result) => result.memory.id)).not.toContain(forbidden.id);
  await testContext.close();
});

test("Explicit context groups can append nearby source memories", async () => {
  const testContext = await createMemoryTestContext();
  const writer = createMemoryModule(testContext.database);
  const seed = await writer.remember(testContext.alice, {
    content: "The orchid launch review starts on Tuesday.",
    metadata: { sourceSession: "session-a", sourceOrdinal: 1 },
  });
  const related = await writer.remember(testContext.alice, {
    content: "Priya approved the cobalt contingency.",
    metadata: { sourceSession: "session-a", sourceOrdinal: 2 },
  });
  await writer.remember(testContext.alice, {
    content: "An unrelated orchid launch review happens elsewhere.",
    metadata: { sourceSession: "session-b", sourceOrdinal: 1 },
  });

  const results = await createMemoryModule(testContext.database, {
    contextGroupExpansion: {
      groupMetadataKey: "sourceSession",
      ordinalMetadataKey: "sourceOrdinal",
      baseCandidateLimit: 1,
      maximumGroups: 1,
    },
    rerankCandidateLimit: 2,
  }).search(testContext.alice, {
    query: "orchid launch Tuesday",
    limit: 2,
  });

  expect(results.map((result) => result.memory.id)).toEqual([seed.id, related.id]);
  await testContext.close();
});

test("Context-group expansion appends without replacing the configured base candidates", async () => {
  const testContext = await createMemoryTestContext();
  const writer = createMemoryModule(testContext.database);
  const seed = await writer.remember(testContext.alice, {
    content: "Atlas launch atlas launch primary evidence.",
    metadata: { sourceSession: "session-a", sourceOrdinal: 1 },
  });
  const related = await writer.remember(testContext.alice, {
    content: "The nearby source turn names Priya.",
    metadata: { sourceSession: "session-a", sourceOrdinal: 2 },
  });
  const second = await writer.remember(testContext.alice, {
    content: "Atlas launch secondary evidence.",
    metadata: { sourceSession: "session-b", sourceOrdinal: 1 },
  });
  const baseline = await writer.search(testContext.alice, {
    query: "atlas launch",
    limit: 2,
  });

  const expanded = await createMemoryModule(testContext.database, {
    contextGroupExpansion: {
      groupMetadataKey: "sourceSession",
      ordinalMetadataKey: "sourceOrdinal",
      baseCandidateLimit: 2,
      maximumGroups: 1,
    },
    rerankCandidateLimit: 3,
  }).search(testContext.alice, {
    query: "atlas launch",
    limit: 3,
  });

  expect(baseline.map((result) => result.memory.id)).toEqual([seed.id, second.id]);
  expect(expanded.slice(0, 2).map((result) => result.memory.id)).toEqual(
    baseline.map((result) => result.memory.id),
  );
  expect(expanded.map((result) => result.memory.id)).toContain(related.id);
  await testContext.close();
});

test("Context-group expansion feeds only authorized candidates to reranking", async () => {
  const testContext = await createMemoryTestContext();
  const writer = createMemoryModule(testContext.database);
  const seed = await writer.remember(testContext.alice, {
    content: "The atlas planning meeting covered the launch window.",
    metadata: { sourceSession: "session-a", sourceOrdinal: 1 },
  });
  const answer = await writer.remember(testContext.alice, {
    content: "The final owner is Lin.",
    metadata: { sourceSession: "session-a", sourceOrdinal: 2 },
  });
  const forbidden = await writer.remember(testContext.alice, {
    content: "The private final owner is Mallory.",
    scope: "private",
    metadata: { sourceSession: "session-a", sourceOrdinal: 3 },
  });
  let rerankedIds: string[] = [];
  const results = await createMemoryModule(testContext.database, {
    contextGroupExpansion: {
      groupMetadataKey: "sourceSession",
      ordinalMetadataKey: "sourceOrdinal",
      baseCandidateLimit: 1,
      maximumGroups: 1,
    },
    rerankingProvider: {
      provider: "fixture",
      model: "fixture-context-reranker-v1",
      async rerank(input) {
        rerankedIds = input.documents.map((document) => document.id);
        return input.documents
          .map((document) => ({
            documentId: document.id,
            score: document.id === answer.id ? 1 : 0,
          }))
          .sort((left, right) => right.score - left.score);
      },
    },
    rerankCandidateLimit: 2,
  }).search(testContext.bob, {
    query: "atlas planning launch window",
    limit: 1,
  });

  expect(rerankedIds).toEqual(expect.arrayContaining([seed.id, answer.id]));
  expect(rerankedIds).not.toContain(forbidden.id);
  expect(results[0]?.memory.id).toBe(answer.id);
  await testContext.close();
});

test("Context-group expansion preserves metadata filters before candidate selection", async () => {
  const testContext = await createMemoryTestContext();
  const writer = createMemoryModule(testContext.database);
  const seed = await writer.remember(testContext.alice, {
    content: "The violet deployment starts after lunch.",
    metadata: { benchmarkPartition: "a", sourceSession: "shared-name", sourceOrdinal: 1 },
  });
  const expected = await writer.remember(testContext.alice, {
    content: "The deployment owner is Ada.",
    metadata: { benchmarkPartition: "a", sourceSession: "shared-name", sourceOrdinal: 2 },
  });
  const otherPartition = await writer.remember(testContext.alice, {
    content: "The deployment owner is Mallory.",
    metadata: { benchmarkPartition: "b", sourceSession: "shared-name", sourceOrdinal: 2 },
  });

  const results = await createMemoryModule(testContext.database, {
    contextGroupExpansion: {
      groupMetadataKey: "sourceSession",
      ordinalMetadataKey: "sourceOrdinal",
      baseCandidateLimit: 1,
      maximumGroups: 1,
    },
    rerankCandidateLimit: 2,
  }).search(testContext.bob, {
    query: "violet deployment after lunch",
    metadataFilter: { benchmarkPartition: "a" },
    limit: 2,
  });

  expect(results.map((result) => result.memory.id)).toEqual([seed.id, expected.id]);
  expect(results.map((result) => result.memory.id)).not.toContain(otherPartition.id);
  await testContext.close();
});

test("Query planning retrieves distinct evidence with vocabulary absent from the original query", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  const expected = await basic.remember(testContext.alice, {
    content: "The automobile maintenance appointment is scheduled for Thursday morning.",
  });
  expect(
    await basic.search(testContext.bob, {
      query: "When is the car service?",
      limit: 5,
    }),
  ).toEqual([]);
  const planned = createMemoryModule(testContext.database, {
    queryPlanningProvider: {
      provider: "fixture",
      model: "fixture-planner-v1",
      async plan(input) {
        expect(input).toEqual({ query: "When is the car service?", maxQueries: 2 });
        return ["automobile maintenance appointment"];
      },
    },
  });

  const results = await planned.search(testContext.bob, {
    query: "When is the car service?",
    limit: 5,
  });

  expect(results.map((result) => result.memory.id)).toContain(expected.id);
  await testContext.close();
});

test("Query planning still filters every expanded query through RLS", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  const shared = await basic.remember(testContext.alice, {
    content: "The obsidian vault passphrase rotation is scheduled for Friday.",
  });
  const privateMemory = await basic.remember(testContext.alice, {
    content: "The private obsidian vault passphrase is lunar-cascade.",
    scope: "private",
  });
  const planned = createMemoryModule(testContext.database, {
    queryPlanningProvider: {
      provider: "fixture",
      model: "fixture-planner-v1",
      async plan() {
        return ["obsidian vault passphrase"];
      },
    },
  });

  const results = await planned.search(testContext.bob, {
    query: "What happened to the recovery credential?",
    limit: 10,
  });

  expect(results.map((result) => result.memory.id)).toContain(shared.id);
  expect(results.map((result) => result.memory.id)).not.toContain(privateMemory.id);
  await testContext.close();
});

test("Query planning failures fall back to the original query", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  await basic.remember(testContext.alice, { content: "Orchid launch schedule alpha." });
  await basic.remember(testContext.alice, { content: "Orchid launch schedule beta." });
  const baseline = await basic.search(testContext.alice, {
    query: "orchid launch",
    limit: 2,
  });
  const planned = createMemoryModule(testContext.database, {
    queryPlanningProvider: {
      provider: "fixture",
      model: "failing-planner-v1",
      async plan() {
        throw new Error("unavailable");
      },
    },
  });

  const results = await planned.search(testContext.alice, {
    query: "orchid launch",
    limit: 2,
  });

  expect(results.map((result) => result.memory.id)).toEqual(
    baseline.map((result) => result.memory.id),
  );
  await testContext.close();
});

test("Reranking reorders only RLS-visible retrieval candidates", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  const first = await basic.remember(testContext.alice, {
    content: "The launch checklist says to verify the fuel valves.",
  });
  const preferred = await basic.remember(testContext.alice, {
    content: "The launch checklist names the final launch owner as Priya.",
  });
  await basic.remember(testContext.alice, {
    content: "The private launch checklist contains a secret override.",
    scope: "private",
  });
  let candidateIds: string[] = [];
  const reranked = createMemoryModule(testContext.database, {
    rerankingProvider: {
      provider: "fixture",
      model: "fixture-reranker-v1",
      async rerank(input) {
        candidateIds = input.documents.map((document) => document.id);
        return [
          { documentId: preferred.id, score: 0.99 },
          { documentId: first.id, score: 0.5 },
        ];
      },
    },
  });

  const results = await reranked.search(testContext.bob, {
    query: "launch checklist",
    limit: 1,
  });

  expect(results).toMatchObject([{ memory: { id: preferred.id }, score: 0.99 }]);
  expect(candidateIds).toContain(first.id);
  expect(candidateIds).toContain(preferred.id);
  expect(candidateIds).toHaveLength(2);
  await testContext.close();
});

test("Reranking scores compact anchor evidence while returning bounded expanded evidence", async () => {
  const testContext = await createMemoryTestContext();
  const content = [
    "0. Atlas status is red.",
    "1. Atlas owner is Priya.",
    "2. Atlas region is west.",
    "3. Atlas status is green.",
    "4. Atlas deadline is Friday.",
    "5. Atlas reviewer is Lin.",
  ].join("\n");
  const memory = await createMemoryModule(testContext.database).remember(testContext.alice, {
    content,
  });
  await replaceMemoryChunks(testContext, testContext.alice, memory.id, content.split("\n"));
  let rerankedEvidence: string | null = null;
  const memories = createMemoryModule(testContext.database, {
    evidenceNeighborChunks: 1,
    evidenceTopChunks: 2,
    rerankingProvider: {
      provider: "fixture",
      model: "compact-evidence-v1",
      async rerank(input) {
        rerankedEvidence = input.documents[0]?.text ?? null;
        return input.documents.map((document) => ({ documentId: document.id, score: 0.9 }));
      },
    },
  });

  const results = await memories.search(testContext.alice, {
    query: "Atlas status",
    limit: 1,
  });

  expect(rerankedEvidence).toBe(
    ["2. Atlas region is west.", "3. Atlas status is green.", "4. Atlas deadline is Friday."].join(
      "\n",
    ),
  );
  expect(results).toMatchObject([{ memory: { id: memory.id }, evidence: content }]);
  expect(JSON.stringify(results)).not.toContain("rerankEvidence");
  await testContext.close();
});

test("Reranking failures fall back to deterministic fused retrieval", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  await basic.remember(testContext.alice, { content: "Orchid launch schedule alpha." });
  await basic.remember(testContext.alice, { content: "Orchid launch schedule beta." });
  const baseline = await basic.search(testContext.alice, { query: "orchid launch", limit: 1 });
  const reranked = createMemoryModule(testContext.database, {
    rerankingProvider: {
      provider: "fixture",
      model: "failing-reranker-v1",
      async rerank() {
        throw new Error("unavailable");
      },
    },
  });

  const results = await reranked.search(testContext.alice, {
    query: "orchid launch",
    limit: 1,
  });

  expect(results.map((result) => result.memory.id)).toEqual(
    baseline.map((result) => result.memory.id),
  );
  await testContext.close();
});

test("Unnormalized reranker scores fall back to deterministic fused retrieval", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  await basic.remember(testContext.alice, { content: "Cedar launch schedule alpha." });
  await basic.remember(testContext.alice, { content: "Cedar launch schedule beta." });
  const baseline = await basic.search(testContext.alice, { query: "cedar launch", limit: 2 });
  const reranked = createMemoryModule(testContext.database, {
    rerankingProvider: {
      provider: "fixture",
      model: "logit-reranker-v1",
      async rerank(input) {
        return input.documents.map((document, index) => ({
          documentId: document.id,
          score: index === 0 ? 4.2 : -1,
        }));
      },
    },
  });

  const results = await reranked.search(testContext.alice, {
    query: "cedar launch",
    limit: 2,
  });

  expect(results.map((result) => result.memory.id)).toEqual(
    baseline.map((result) => result.memory.id),
  );
  await testContext.close();
});

test("Weighted rerank fusion can preserve strong first-stage evidence", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  await basic.remember(testContext.alice, {
    content: "Atlas launch evidence alpha confirms the release owner.",
  });
  await basic.remember(testContext.alice, {
    content: "Atlas launch evidence beta confirms the release date.",
  });
  const baseline = await basic.search(testContext.alice, {
    query: "Atlas launch evidence",
    limit: 2,
  });
  const reranked = createMemoryModule(testContext.database, {
    rerankWeight: 0,
    rerankingProvider: {
      provider: "fixture",
      model: "reverse-reranker-v1",
      async rerank(input) {
        return [...input.documents].reverse().map((document, index) => ({
          documentId: document.id,
          score: 0.99 - index * 0.1,
        }));
      },
    },
  });

  const results = await reranked.search(testContext.alice, {
    query: "Atlas launch evidence",
    limit: 2,
  });

  expect(results.map((result) => result.memory.id)).toEqual(
    baseline.map((result) => result.memory.id),
  );
  expect(results.every((result) => result.rerankScore !== undefined)).toBe(true);
  await testContext.close();
});

test("A calibrated reranker can abstain even when fusion found one candidate", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  await basic.remember(testContext.alice, {
    content: "The recovery key is stored in the blue operations binder.",
  });
  let rerankCalls = 0;
  const reranked = createMemoryModule(testContext.database, {
    rerankMinimumScore: 0.01,
    rerankingProvider: {
      provider: "fixture",
      model: "calibrated-reranker-v1",
      async rerank(input) {
        rerankCalls += 1;
        return input.documents.map((document) => ({
          documentId: document.id,
          score: 0.001,
        }));
      },
    },
  });

  const results = await reranked.search(testContext.alice, {
    query: "What is the recovery key?",
    limit: 5,
  });

  expect(rerankCalls).toBe(1);
  expect(results).toEqual([]);
  await testContext.close();
});

test("Optional rerank diversity avoids filling top-k with near-duplicate evidence", async () => {
  const testContext = await createMemoryTestContext();
  const basic = createMemoryModule(testContext.database);
  const first = await basic.remember(testContext.alice, {
    content: "Project Atlas launch checklist confirms the blue release train for Friday.",
  });
  const duplicate = await basic.remember(testContext.alice, {
    content: "Project Atlas launch checklist confirms the blue release train Friday.",
  });
  const diverse = await basic.remember(testContext.alice, {
    content: "Project Atlas launch owner is Priya from the reliability team.",
  });
  const reranked = createMemoryModule(testContext.database, {
    rerankDiversityLambda: 0.3,
    rerankingProvider: {
      provider: "fixture",
      model: "diversity-reranker-v1",
      async rerank() {
        return [
          { documentId: first.id, score: 0.9 },
          { documentId: duplicate.id, score: 0.89 },
          { documentId: diverse.id, score: 0.8 },
        ];
      },
    },
  });

  const results = await reranked.search(testContext.alice, {
    query: "What does the Project Atlas launch checklist say?",
    limit: 2,
  });

  expect(results.map((result) => result.memory.id)).toEqual([first.id, diverse.id]);
  await testContext.close();
});

test("Hybrid search finds semantically related visible Memory without lexical overlap", async () => {
  const testContext = await createMemoryTestContext();
  const fixtureVector = (index: number) =>
    Array.from({ length: 1024 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
  const embeddingTasks: EmbeddingTask[] = [];
  const embeddingProvider = {
    provider: "fixture",
    model: "fixture-embedding-v1",
    dimensions: 1024 as const,
    revision: "fixture-v1",
    async embed(texts: string[], task: EmbeddingTask) {
      embeddingTasks.push(task);
      return texts.map((text) =>
        /cat|feline/i.test(text)
          ? fixtureVector(0)
          : /rocket|orbital/i.test(text)
            ? fixtureVector(1)
            : fixtureVector(2),
      );
    },
  };
  const memories = createMemoryModule(testContext.database, { embeddingProvider });
  const visible = await memories.remember(testContext.alice, {
    content: "The feline sleeps beside the warm window.",
  });
  await memories.remember(testContext.alice, {
    content: "Alice keeps a private feline health note.",
    scope: "private",
  });
  await memories.remember(testContext.carol, {
    content: "Research has another feline observation.",
  });
  await memories.remember(testContext.alice, {
    content: "The orbital vehicle completed its burn.",
  });

  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider,
  });
  while ((await maintenance.run()).status === "complete") {
    // Drain the four deterministic document jobs before semantic search.
  }

  const results = await memories.search(testContext.bob, { query: "cat", limit: 10 });

  expect(results.map((result) => result.memory.id)).toEqual([visible.id]);
  expect(embeddingTasks).toContain("document");
  expect(embeddingTasks.at(-1)).toBe("query");
  await testContext.close();
});

test("Bounded retrieval feedback follows a visible semantic hop without leaking its source", async () => {
  const testContext = await createMemoryTestContext();
  const queryTexts: string[] = [];
  const vector = (index: number) =>
    Array.from({ length: 1024 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
  const embeddingProvider = {
    provider: "fixture",
    model: "fixture-feedback-v1",
    dimensions: 1024 as const,
    revision: "fixture-v1",
    async embed(texts: string[], task: EmbeddingTask) {
      if (task === "query") queryTexts.push(...texts);
      return texts.map((text) => {
        if (task === "query") return /\bBob\b/.test(text) ? vector(1) : vector(0);
        return /\bRome\b|classified/.test(text) ? vector(1) : vector(0);
      });
    },
  };
  const writer = createMemoryModule(testContext.database, { embeddingProvider });
  const distractor = await writer.remember(testContext.alice, {
    content: "Alice keeps an old spouse directory in the Oslo archive.",
  });
  const firstHop = await writer.remember(testContext.alice, {
    content:
      "A storage audit mentions the unrelated codename Zephyr. Alice's spouse is Bob. A weather note predicts rain in Lisbon.",
  });
  const secondHop = await writer.remember(testContext.alice, {
    content: "Bob was born in Rome.",
  });
  const forbidden = await writer.remember(testContext.bob, {
    content: "Bob's classified birthplace record says Paris.",
    scope: "private",
  });
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider,
  });
  while ((await maintenance.run()).status === "complete") {
    // Drain deterministic document embedding jobs.
  }

  const withoutFeedback = await writer.search(testContext.alice, {
    query: "Where was Alice's spouse born?",
    limit: 2,
  });
  const withFeedback = await createMemoryModule(testContext.database, {
    embeddingProvider,
    retrievalFeedbackQueries: 1,
  }).search(testContext.alice, {
    query: "Where was Alice's spouse born?",
    limit: 2,
  });

  expect(withoutFeedback.map((result) => result.memory.id)).toEqual([firstHop.id, distractor.id]);
  expect(withFeedback.map((result) => result.memory.id)).toEqual([firstHop.id, secondHop.id]);
  expect(withFeedback.map((result) => result.memory.id)).not.toContain(forbidden.id);
  expect(queryTexts.at(-1)).toContain("Alice's spouse is Bob");
  expect(queryTexts.at(-1)).not.toContain("Zephyr");
  expect(queryTexts.at(-1)).not.toContain("Lisbon");
  await testContext.close();
});

test("Bounded retrieval feedback can follow an iterative three-hop chain", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const firstHop = await memories.remember(testContext.alice, {
    content: "Alicevra's spouse is Bobnix.",
  });
  const secondHop = await memories.remember(testContext.alice, {
    content: "Bobnix's employer is Acmequill.",
  });
  const thirdHop = await memories.remember(testContext.alice, {
    content: "Acmequill's headquarters are in Berlinora.",
  });
  const forbidden = await memories.remember(testContext.bob, {
    content: "Acmequill's private headquarters are in Parisora.",
    scope: "private",
  });

  const withoutFeedback = await memories.search(testContext.alice, {
    query: "Where is Alicevra's spouse's employer headquartered?",
    limit: 3,
  });
  const withFeedback = await createMemoryModule(testContext.database, {
    retrievalFeedbackQueries: 2,
  }).search(testContext.alice, {
    query: "Where is Alicevra's spouse's employer headquartered?",
    limit: 3,
  });

  expect(withoutFeedback.map((result) => result.memory.id)).toEqual([firstHop.id]);
  expect(withFeedback.map((result) => result.memory.id)).toEqual([
    firstHop.id,
    secondHop.id,
    thirdHop.id,
  ]);
  expect(withFeedback.map((result) => result.memory.id)).not.toContain(forbidden.id);
  await testContext.close();
});

test("Memory list contains shared and owner-private Memories but no private neighbors", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const shared = await memories.remember(testContext.alice, { content: "Shared operations note." });
  await memories.remember(testContext.alice, {
    content: "Alice private operations note.",
    scope: "private",
  });
  const bobPrivate = await memories.remember(testContext.bob, {
    content: "Bob private operations note.",
    scope: "private",
  });

  const listed = await memories.list(testContext.bob, { limit: 20 });

  expect(new Set(listed.map((memory) => memory.id))).toEqual(new Set([shared.id, bobPrivate.id]));
  await testContext.close();
});

test("Memory list supports stable offset paging inside the authorized result set", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  await memories.remember(testContext.alice, { content: "First paging memory." });
  await memories.remember(testContext.alice, { content: "Second paging memory." });
  await memories.remember(testContext.alice, { content: "Third paging memory." });

  const full = await memories.list(testContext.alice, { limit: 10 });
  const page = await memories.list(testContext.alice, { limit: 1, offset: 1 });

  expect(page).toEqual(full.slice(1, 2));
  await testContext.close();
});
