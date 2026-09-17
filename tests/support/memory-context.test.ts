import { expect, test } from "vitest";
import { createMemoryModule } from "../../src/modules/memories/service";
import { installActorContext } from "../../src/server/auth/actor-context";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-context";

async function state(context: MemoryTestContext) {
  return context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query(
      `SELECT
         (SELECT count(*)::int FROM memories) AS memories,
         (SELECT count(*)::int FROM memory_embedding_jobs) AS jobs,
         (SELECT count(*)::int FROM memory_events) AS events,
         (SELECT status FROM memberships WHERE workspace_id = $1 AND user_id = $2) AS membership`,
      [context.alice.workspaceId, context.alice.userId],
    );
    return result.rows[0];
  });
}

test("contexts isolate writes, membership changes and derived state across close and recreation", async () => {
  const first = await createMemoryTestContext();
  const second = await createMemoryTestContext();
  const firstMemories = createMemoryModule(first.database, {
    embeddingProvider: {
      provider: "test",
      model: "fixture-isolation",
      revision: "v1",
      dimensions: 1024,
      async embed() {
        throw new Error("Fixture isolation must not call an embedding model");
      },
    },
  });
  await firstMemories.remember(first.alice, { content: "Only the first database stores this." });
  await first.suspendMembership(first.alice);
  await expect(state(first)).resolves.toEqual({
    memories: 1,
    jobs: 1,
    events: 1,
    membership: "suspended",
  });
  const clean = { memories: 0, jobs: 0, events: 0, membership: "active" };
  await expect(state(second)).resolves.toEqual(clean);
  await first.close();

  const secondMemories = createMemoryModule(second.database);
  const survivor = await secondMemories.remember(second.alice, {
    content: "The second database still works after the first closes.",
  });
  await expect(secondMemories.retrieve(second.alice, survivor.id)).resolves.toEqual(survivor);
  const third = await createMemoryTestContext();
  await expect(state(third)).resolves.toEqual(clean);
});

test("contexts preserve database roles, rollback and transaction-local Actor cleanup", async () => {
  const context = await createMemoryTestContext();
  const failure = new Error("Roll back fixture mutation");
  await expect(
    context.adminDatabase.transaction(async (transaction) => {
      await installActorContext(transaction, context.alice);
      await transaction.query("UPDATE users SET display_name = 'Changed' WHERE id = $1", [
        context.alice.userId,
      ]);
      await transaction.query("SET LOCAL ROLE lore_maintenance");
      throw failure;
    }),
  ).rejects.toBe(failure);

  for (const { database, role } of [
    { database: context.database, role: "lore_app" },
    { database: context.maintenanceDatabase, role: "lore_maintenance" },
    { database: context.adminDatabase, role: "postgres" },
  ]) {
    await expect(
      database.transaction((transaction) =>
        transaction.query(
          "SELECT current_user AS role, NULLIF(current_setting('lore.user_id', true), '') AS actor",
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ role, actor: null }] });
  }
  await expect(
    context.adminDatabase.transaction((transaction) =>
      transaction.query("SELECT display_name FROM users WHERE id = $1", [context.alice.userId]),
    ),
  ).resolves.toMatchObject({ rows: [{ display_name: "Alice" }] });
});
