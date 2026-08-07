import { expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import { installActorContext } from "@/lib/actor-context";
import { createMemoryMaintenanceModule } from "@/lib/maintenance";
import { createMemoryModule, type EmbeddingTask, MemoryAccessDeniedError } from "@/lib/memory";
import { createMemoryTestContext } from "./support/memory-context";

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
      transaction.query("SELECT id FROM memory_chunks WHERE memory_id = $1", [created.id]),
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
      const result = await transaction.query<{ id: string }>(
        "SELECT id FROM memory_chunks WHERE memory_id = $1 ORDER BY ordinal",
        [created.id],
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
      transaction.query("SELECT id, content FROM memory_chunks WHERE memory_id = $1", [created.id]),
    ).resolves.toMatchObject({ rows: [] });
  });
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
