import {
  type PostgresDatabase,
  type PostgresTransaction,
  transactionThrough,
} from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { mutationRequestHash } from "@/server/api/idempotency";
import { type ActorContext, installActorContext } from "@/server/auth/actor-context";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

// A keyed write locks its Memory, then writes and completes its ledger row in one
// final batch. Write authority can be revoked between the two, so the write matches
// no row; the ledger must then record what the first response said, never a write
// that did not happen. PGlite has one session, so the revocation runs inside the
// write's own transaction just before its write statement, where a concurrent
// commit would become visible.

/** Run `interleave` inside each transaction just before the first statement matching `pattern`. */
function interleaved(
  database: PostgresDatabase,
  pattern: RegExp,
  interleave: (transaction: PostgresTransaction) => Promise<void>,
): PostgresDatabase {
  return {
    transaction: (use, options) =>
      database.transaction((transaction) => {
        let ran = false;
        return use(
          transactionThrough(transaction, async <Row>(sql: string, params?: unknown[]) => {
            if (!ran && pattern.test(sql)) {
              ran = true;
              await interleave(transaction);
            }
            return transaction.query<Row>(sql, params);
          }),
        );
      }, options),
  };
}

async function fixture() {
  const context = await createMemoryTestContext();
  const access = createAccessModule(context.database);
  const agent = await access.createAgentForWorkspace(context.alice, {
    name: "Replay race Agent",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(context.alice, agent.id);
  const actor = await access.authenticateAgent(credential.token, context.alice.workspaceId);
  if (!actor) throw new Error("Agent authentication failed in fixture");
  const memory = await createMemoryModule(context.database).remember(actor, {
    content: "Written by the Agent before its grant was narrowed.",
  });
  return { context, actor, agentId: agent.id, memory };
}

/** The Agent's owner narrows its grant to read, between the lock and the write. */
function narrowGrant(context: MemoryTestContext, actor: ActorContext, agentId: string) {
  return async (transaction: PostgresTransaction) => {
    installActorContext(transaction, context.alice);
    await transaction.query(
      `UPDATE agent_workspace_grants SET permission = 'read'
       WHERE agent_id = $1 AND workspace_id = $2`,
      [agentId, context.alice.workspaceId],
    );
    installActorContext(transaction, actor);
  };
}

async function keyed(operation: string, payload: unknown) {
  return {
    key: `${operation}-race`,
    operation,
    requestHash: await mutationRequestHash({ operation, payload }),
  };
}

test("a content update refused after its lock answers not found and records nothing", async () => {
  const { context, actor, agentId, memory } = await fixture();
  const change = { content: "This replacement never lands." };
  const racing = createMemoryModule(
    interleaved(context.database, /^\s*UPDATE memories/, narrowGrant(context, actor, agentId)),
  );
  const options = { expectedVersion: 1, idempotency: await keyed("memory.update", change) };

  // The store refuses the chunk rewrite, so the whole transaction rolls back; the
  // retry with the same key runs afresh and is refused at its lock. (Here the
  // narrowing ran inside the rolled-back transaction, so it is committed again, as
  // the concurrent writer's own commit would be.)
  await expect(racing.update(actor, memory.id, change, options)).resolves.toBeNull();
  await context.adminDatabase.transaction((transaction) =>
    transaction.query("UPDATE agent_workspace_grants SET permission = 'read' WHERE agent_id = $1", [
      agentId,
    ]),
  );
  await expect(
    createMemoryModule(context.database).update(actor, memory.id, change, options),
  ).resolves.toBeNull();
  await expect(
    createMemoryModule(context.database).retrieve(context.alice, memory.id),
  ).resolves.toMatchObject({ version: 1, content: memory.content });
});

test("a metadata-only update whose write matched no row replays as not found", async () => {
  const { context, actor, agentId, memory } = await fixture();
  const change = { metadata: { narrowed: true } };
  const racing = createMemoryModule(
    interleaved(context.database, /^\s*UPDATE memories/, narrowGrant(context, actor, agentId)),
  );
  const options = { expectedVersion: 1, idempotency: await keyed("memory.update", change) };

  // No chunk is rewritten, so the batch commits with the UPDATE having matched no row.
  await expect(racing.update(actor, memory.id, change, options)).resolves.toBeNull();
  await expect(
    createMemoryModule(context.database).update(actor, memory.id, change, options),
  ).resolves.toBeNull();
  await expect(
    createMemoryModule(context.database).retrieve(context.alice, memory.id),
  ).resolves.toMatchObject({ version: 1, metadata: {} });
});

test("a forget whose delete matched no row replays as not deleted, and the Memory survives", async () => {
  const { context, actor, agentId, memory } = await fixture();
  const racing = createMemoryModule(
    interleaved(context.database, /^\s*DELETE FROM memories/, narrowGrant(context, actor, agentId)),
  );
  const options = { expectedVersion: 1, idempotency: await keyed("memory.delete", {}) };

  await expect(racing.forget(actor, memory.id, options)).resolves.toBe(false);
  await expect(
    createMemoryModule(context.database).forget(actor, memory.id, options),
  ).resolves.toBe(false);
  await expect(
    createMemoryModule(context.database).retrieve(context.alice, memory.id),
  ).resolves.toMatchObject({ id: memory.id, version: 1 });
});

test("an applied keyed update and forget still record and replay their results", async () => {
  const { context, actor, memory } = await fixture();
  const memories = createMemoryModule(context.database);
  const change = { content: "This replacement lands." };
  const updateOptions = { expectedVersion: 1, idempotency: await keyed("memory.update", change) };
  const forgetOptions = { expectedVersion: 2, idempotency: await keyed("memory.delete", {}) };

  const updated = await memories.update(actor, memory.id, change, updateOptions);
  expect(updated).toMatchObject({ version: 2, content: change.content });
  await expect(memories.update(actor, memory.id, change, updateOptions)).resolves.toEqual(updated);
  await expect(memories.forget(actor, memory.id, forgetOptions)).resolves.toBe(true);
  await expect(memories.forget(actor, memory.id, forgetOptions)).resolves.toBe(true);
});

test("a keyed no-op update writes nothing and replays the unchanged Memory, even after narrowing", async () => {
  const { context, actor, agentId, memory } = await fixture();
  // Equal content: nothing differs, so the batch carries no UPDATE, only the ledger
  // completion, which finds the Memory at the version it already holds.
  const change = { content: memory.content };
  const racing = createMemoryModule(
    interleaved(context.database, /^\s*WITH completed AS/, narrowGrant(context, actor, agentId)),
  );
  const options = { expectedVersion: 1, idempotency: await keyed("memory.update", change) };

  const first = await racing.update(actor, memory.id, change, options);
  expect(first).toEqual(memory);
  await expect(
    createMemoryModule(context.database).update(actor, memory.id, change, options),
  ).resolves.toEqual(first);
});
