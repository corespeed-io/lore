import {
  type EmbeddingProvider,
  type PostgresDatabase,
  transactionThrough,
} from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createMemoryModule } from "@/modules/memories/service";
import { mutationRequestHash } from "@/server/api/idempotency";
import { actorTransaction, PendingActor } from "@/server/auth/actor-admission";
import { agentCredentialHash } from "@/server/auth/agent-credentials";
import { WorkspaceAccessError } from "@/server/auth/auth";
import { createIdentityModule } from "@/server/auth/identity";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

const principal = {
  provider: "test",
  subject: "admission-human",
  displayName: "Admission Human",
};

/** Every statement the database is sent, and when each transaction begins. */
function recording(database: PostgresDatabase) {
  const log: string[] = [];
  const recorded: PostgresDatabase = {
    transaction: (use, options) => {
      log.push("transaction");
      return database.transaction(
        (transaction) =>
          use(
            transactionThrough(transaction, (sql, params) => {
              log.push(sql.replace(/\s+/g, " ").trim());
              return transaction.query(sql, params);
            }),
          ),
        options,
      );
    },
  };
  return { database: recorded, log };
}

async function fixture(context: MemoryTestContext) {
  const user = await createIdentityModule(context.database).register(principal);
  const access = createAccessModule(context.database);
  const workspace = await access.createWorkspace({ userId: user.id }, { name: "Admission Lab" });
  const owner = { workspaceId: workspace.id, userId: user.id };
  const agent = await access.createAgentForWorkspace(owner, {
    name: "Admission Agent",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(owner, agent.id);
  return {
    owner,
    agentId: agent.id,
    human: () => PendingActor.human(principal, workspace.id),
    agent: async () =>
      PendingActor.agent(await agentCredentialHash(credential.token), workspace.id),
  };
}

function embeddings(onEmbed: () => void): EmbeddingProvider {
  return {
    provider: "fixture",
    model: "admission-v1",
    revision: "fixture-v1",
    dimensions: 1024,
    async embed(texts) {
      onEmbed();
      return texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)));
    },
  };
}

test("a pending human is admitted by the read's own statements and sees what a member sees", async () => {
  const context = await createMemoryTestContext();
  const { owner, human } = await fixture(context);
  await createMemoryModule(context.database).remember(owner, { content: "Harbor notes." });
  const { database, log } = recording(context.database);
  const actor = human();

  const listed = await createMemoryModule(database).list(actor);

  expect(listed.map((memory) => memory.content)).toEqual(["Harbor notes."]);
  expect(actor.actor).toEqual(owner);
  // One transaction: the admission first, then the read behind it. (This wrapper
  // feeds a batch one statement at a time, so the membership check may follow the
  // read here; an adapter sends both admission statements first.)
  expect(log.filter((entry) => entry === "transaction")).toHaveLength(1);
  expect(log[1]).toContain("lore.resolve_identity");
  expect(log.slice(2, 4).some((entry) => entry.includes("lore.is_active_member"))).toBe(true);
  expect(log.slice(2, 4).some((entry) => entry.includes("FROM memories"))).toBe(true);
});

test("a refused admission answers WorkspaceAccessError even though its read ran", async () => {
  const context = await createMemoryTestContext();
  const { owner } = await fixture(context);
  await createMemoryModule(context.database).remember(owner, { content: "Private to members." });
  const memories = createMemoryModule(context.database);

  // A registered human with no Membership, an unknown Identity, and an unknown token.
  await createIdentityModule(context.database).register({ ...principal, subject: "outsider" });
  for (const actor of [
    PendingActor.human({ ...principal, subject: "outsider" }, owner.workspaceId),
    PendingActor.human({ ...principal, subject: "never-registered" }, owner.workspaceId),
    PendingActor.agent(
      await agentCredentialHash(`lore_agent_${"0".repeat(64)}`),
      owner.workspaceId,
    ),
  ]) {
    await expect(memories.list(actor)).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(
      memories.remember(actor, { content: "An outsider's write." }),
    ).rejects.toBeInstanceOf(WorkspaceAccessError);
  }
  const stored = await context.adminDatabase.transaction((transaction) =>
    transaction.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM memories WHERE workspace_id = $1",
      [owner.workspaceId],
    ),
  );
  expect(stored.rows[0]?.count).toBe(1);
});

test("a suspended Membership is refused by the prefix", async () => {
  const context = await createMemoryTestContext();
  const { owner, human } = await fixture(context);
  await context.suspendMembership(owner);

  await expect(createMemoryModule(context.database).list(human())).rejects.toBeInstanceOf(
    WorkspaceAccessError,
  );
});

test("an Agent's search pays no provider before its admission returns; a human's admits after", async () => {
  const context = await createMemoryTestContext();
  const { owner, human, agent } = await fixture(context);
  await createMemoryModule(context.database).remember(owner, { content: "Tide table." });
  const agentActor = await agent();
  const humanActor = human();
  const observed: Array<{ actor: string; admitted: boolean; admitting: boolean }> = [];
  const searchAs = (name: string, actor: PendingActor) =>
    createMemoryModule(context.database, {
      embeddingProvider: embeddings(() =>
        observed.push({
          actor: name,
          admitted: actor.actor !== undefined,
          admitting: actor.admission !== undefined,
        }),
      ),
    }).search(actor, { query: "tide table" });

  await expect(searchAs("agent", agentActor)).resolves.toHaveLength(1);
  await expect(searchAs("human", humanActor)).resolves.toHaveLength(1);
  // An unauthenticated token never reaches a provider; a verified human's admission
  // travels with the first pass after the provider call.
  expect(observed).toEqual([
    { actor: "agent", admitted: true, admitting: true },
    { actor: "human", admitted: false, admitting: false },
  ]);

  const unknown = PendingActor.agent(
    await agentCredentialHash(`lore_agent_${"1".repeat(64)}`),
    owner.workspaceId,
  );
  await expect(searchAs("unknown", unknown)).rejects.toBeInstanceOf(WorkspaceAccessError);
  expect(observed.map((entry) => entry.actor)).not.toContain("unknown");
});

test("one request admits once, however many transactions bind its Actor", async () => {
  const context = await createMemoryTestContext();
  const { human } = await fixture(context);
  const { database, log } = recording(context.database);
  const actor = human();
  const memories = createMemoryModule(database);

  await Promise.all([memories.list(actor), memories.list(actor), memories.list(actor)]);
  await memories.list(actor);

  expect(log.filter((entry) => entry.includes("lore.resolve_identity"))).toHaveLength(1);
});

test("an Agent is admitted before a read-only snapshot, a human inside it", async () => {
  const context = await createMemoryTestContext();
  const { owner, human, agent } = await fixture(context);
  await createMemoryModule(context.database).remember(owner, { content: "Graph node." });

  for (const [actor, transactions] of [
    [human(), 1],
    [await agent(), 2],
  ] as const) {
    const { database, log } = recording(context.database);
    const graph = await createMemoryGraphModule(database).read(actor);
    expect(graph.nodes).toHaveLength(1);
    expect(log.filter((entry) => entry === "transaction")).toHaveLength(transactions);
  }
});

test("a keyed write's stored body is the Memory the write returned", async () => {
  const context = await createMemoryTestContext();
  const { agent } = await fixture(context);
  const memories = createMemoryModule(context.database);
  const keyed = async (operation: string, payload: unknown) => ({
    idempotency: {
      key: `${operation}-key`,
      operation,
      requestHash: await mutationRequestHash({ operation, payload }),
    },
  });
  const input = {
    content: "Ünïcode — 注意 \u{1F30A} body.",
    scope: "private" as const,
    metadata: { nested: { list: [1, 2.5, "three", null], flag: true }, "key with space": "v" },
  };

  const created = await memories.remember(await agent(), input, await keyed("create", input));
  const replayedCreate = await memories.remember(
    await agent(),
    input,
    await keyed("create", input),
  );
  const change = { content: "Replaced body.", metadata: { revised: true } };
  const updated = await memories.update(await agent(), created.id, change, {
    expectedVersion: 1,
    ...(await keyed("update", change)),
  });
  const replayedUpdate = await memories.update(await agent(), created.id, change, {
    expectedVersion: 1,
    ...(await keyed("update", change)),
  });

  expect(created.createdByAgentId).not.toBeNull();
  expect(replayedCreate).toEqual(created);
  expect(updated).toMatchObject({ version: 2, content: "Replaced body." });
  expect(replayedUpdate).toEqual(updated);
});

test("a replayed forget rolls back its own delete", async () => {
  const context = await createMemoryTestContext();
  const { owner, human } = await fixture(context);
  const memories = createMemoryModule(context.database);
  const keyed = async () => ({
    expectedVersion: 1,
    idempotency: {
      key: "forget-key",
      operation: "memory.delete",
      requestHash: await mutationRequestHash({ operation: "memory.delete" }),
    },
  });
  const forgotten = await memories.remember(owner, { content: "Forget me." });
  await expect(memories.forget(human(), forgotten.id, await keyed())).resolves.toBe(true);

  // The same key again replays the stored result without deleting anything.
  await expect(memories.forget(human(), forgotten.id, await keyed())).resolves.toBe(true);
  await expect(
    actorTransaction(context.database, owner, (transaction) =>
      transaction.query("SELECT status FROM request_idempotency_records"),
    ),
  ).resolves.toMatchObject({ rows: [{ status: "completed" }] });
});
