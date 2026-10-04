import type { PostgresDatabase, PostgresTransaction } from "@corespeed/lore-core";
import { MEMORY_LINK_LIMITS, transactionThrough } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createMemoryModule } from "@/modules/memories/service";
import { type ActorContext, installActorContext } from "@/server/auth/actor-context";
import { createAccessModule } from "../support/access";
import type { MemoryTestContext } from "../support/memory-context";
import { createMemoryTestContext } from "../support/memory-context";

// Link writes (connect/disconnect) authorize through RLS alone: the source must be
// writable by the Actor and the target readable. A Link list shows a Link only when
// both endpoints are readable. Each case pairs what an Actor may do with what it may
// not, and a refusal never reveals whether the Link exists.

async function fixture() {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const graph = createMemoryGraphModule(context.database);
  const access = createAccessModule(context.database);
  const aliceShared = await memories.remember(context.alice, { content: "Alice shared plan." });
  const aliceSharedTwo = await memories.remember(context.alice, { content: "Alice shared risk." });
  const alicePrivate = await memories.remember(context.alice, {
    content: "Alice private note.",
    scope: "private",
  });
  const bobShared = await memories.remember(context.bob, { content: "Bob shared plan." });
  const bobPrivate = await memories.remember(context.bob, {
    content: "Bob private note.",
    scope: "private",
  });
  const carolShared = await memories.remember(context.carol, { content: "Carol research." });
  return {
    access,
    context,
    graph,
    memories,
    ids: {
      aliceShared: aliceShared.id,
      aliceSharedTwo: aliceSharedTwo.id,
      alicePrivate: alicePrivate.id,
      bobShared: bobShared.id,
      bobPrivate: bobPrivate.id,
      carolShared: carolShared.id,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function link(graph: Fixture["graph"], actor: ActorContext, source: string, target: string) {
  return graph.connect(actor, { sourceMemoryId: source, targetMemoryId: target });
}

function unlink(graph: Fixture["graph"], actor: ActorContext, source: string, target: string) {
  return graph.disconnect(actor, { sourceMemoryId: source, targetMemoryId: target });
}

/** The durable Links in an Actor's Graph, without the derived affinity edges. */
async function visibleLinks(graph: Fixture["graph"], actor: ActorContext) {
  return (await graph.read(actor)).links.filter((edge) => !edge.derived);
}

/** Every stored Link, read past RLS, so a refused write can be shown to change nothing. */
async function storedLinks(context: MemoryTestContext) {
  const result = await context.adminDatabase.transaction((transaction) =>
    transaction.query<{ source_memory_id: string; target_memory_id: string; weight: number }>(
      "SELECT source_memory_id, target_memory_id, weight FROM memory_links ORDER BY created_at, id",
    ),
  );
  return result.rows.map((row) => ({
    source: row.source_memory_id,
    target: row.target_memory_id,
    weight: row.weight,
  }));
}

async function agentActor(
  access: Fixture["access"],
  owner: ActorContext,
  permission: "read" | "write",
) {
  const agent = await access.createAgentForWorkspace(owner, {
    name: `${permission} agent`,
    permission,
  });
  const credential = await access.issueAgentCredential(owner, agent.id);
  const actor = await access.authenticateAgent(credential.token, owner.workspaceId);
  if (!actor) throw new Error("Expected the Agent to authenticate");
  return { agent, actor };
}

test("a Link never crosses a Workspace in either direction", async () => {
  const { context, graph, ids } = await fixture();

  await expect(link(graph, context.alice, ids.aliceShared, ids.carolShared)).resolves.toBeNull();
  await expect(link(graph, context.carol, ids.carolShared, ids.aliceShared)).resolves.toBeNull();
  // Naming another Workspace's Memory as the source is refused the same way.
  await expect(link(graph, context.carol, ids.aliceShared, ids.aliceSharedTwo)).resolves.toBeNull();
  // An Actor bound to a Workspace it is not a member of can write nothing there.
  const aliceInResearch = { ...context.alice, workspaceId: context.carol.workspaceId };
  await expect(link(graph, aliceInResearch, ids.carolShared, ids.aliceShared)).resolves.toBeNull();

  await expect(
    link(graph, context.alice, ids.aliceShared, ids.aliceSharedTwo),
  ).resolves.toMatchObject({ created: true });
  await expect(unlink(graph, context.carol, ids.aliceShared, ids.aliceSharedTwo)).resolves.toBe(
    false,
  );
  expect(await storedLinks(context)).toHaveLength(1);
});

test("a co-member may link from their own Memory to a visible one, never from another's", async () => {
  const { context, graph, ids } = await fixture();

  await expect(link(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toMatchObject({
    created: true,
    link: { sourceMemoryId: ids.bobShared, targetMemoryId: ids.aliceShared },
  });
  // Bob can read Alice's shared Memory but may not write it, so it cannot be a source.
  await expect(link(graph, context.bob, ids.aliceShared, ids.bobShared)).resolves.toBeNull();
  await expect(
    link(graph, context.alice, ids.aliceShared, ids.aliceSharedTwo),
  ).resolves.toMatchObject({
    created: true,
  });
  await expect(unlink(graph, context.bob, ids.aliceShared, ids.aliceSharedTwo)).resolves.toBe(
    false,
  );
  // Alice owns the target of Bob's Link, which gives her no authority over it.
  await expect(unlink(graph, context.alice, ids.bobShared, ids.aliceShared)).resolves.toBe(false);
  expect(await storedLinks(context)).toHaveLength(2);
});

test("a co-member cannot rewrite another User's existing Link", async () => {
  const { context, graph, ids } = await fixture();
  const key = { sourceMemoryId: ids.aliceShared, targetMemoryId: ids.aliceSharedTwo };
  const original = await graph.connect(context.alice, { ...key, metadata: { by: "alice" } });

  // Bob can see the Link in his Graph, yet may not replace its weight or metadata.
  await expect(
    graph.connect(context.bob, { ...key, weight: 0.1, metadata: { by: "bob" } }),
  ).resolves.toBeNull();
  await expect(
    graph.connect(context.alice, { ...key, metadata: { by: "alice" } }),
  ).resolves.toEqual({ link: original?.link, created: false });
});

test("a private target is linkable only by its owner, and refusal matches a missing target", async () => {
  const { context, graph, ids } = await fixture();
  const missing = "40000000-0000-4000-8000-0000000000ff";

  await expect(
    link(graph, context.alice, ids.aliceShared, ids.alicePrivate),
  ).resolves.toMatchObject({
    created: true,
  });
  await expect(link(graph, context.alice, ids.aliceShared, ids.bobPrivate)).resolves.toBeNull();
  await expect(link(graph, context.alice, ids.aliceShared, missing)).resolves.toBeNull();

  // Bob's own Link to his private Memory exists; Alice cannot tell it from none.
  await expect(link(graph, context.bob, ids.bobShared, ids.bobPrivate)).resolves.toMatchObject({
    created: true,
  });
  await expect(unlink(graph, context.alice, ids.bobShared, ids.bobPrivate)).resolves.toBe(false);
  await expect(unlink(graph, context.alice, ids.bobShared, missing)).resolves.toBe(false);
  expect(await storedLinks(context)).toHaveLength(2);
});

test("a Link bound counts only the Links its writer can see", async () => {
  const { context, graph, ids, memories } = await fixture();
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query("SET LOCAL session_replication_role = replica");
    await transaction.query(
      `INSERT INTO memory_links (id, workspace_id, source_memory_id, target_memory_id, kind)
       SELECT gen_random_uuid(), $1, $2, $3, 'kind-' || index
       FROM generate_series(1, $4::integer) AS index`,
      [
        context.bob.workspaceId,
        ids.bobShared,
        ids.aliceShared,
        MEMORY_LINK_LIMITS.maximumLinksPerSource,
      ],
    );
  });

  await expect(link(graph, context.bob, ids.bobShared, ids.bobPrivate)).rejects.toMatchObject({
    limit: "maximumLinksPerSource",
  });
  // Once their target is private, Bob can no longer see those Links, and a bound
  // that counted them would reveal that Alice's Memory still exists.
  await memories.update(context.alice, ids.aliceShared, { scope: "private" });
  await expect(link(graph, context.bob, ids.bobShared, ids.bobPrivate)).resolves.toMatchObject({
    created: true,
  });
});

test("one User's Agents share that User's Links by their own grants", async () => {
  const { access, context, graph, ids } = await fixture();
  const writer = await agentActor(access, context.alice, "write");
  const reader = await agentActor(access, context.alice, "read");

  // A write-granted Agent acts for Alice, private Memories included.
  await expect(link(graph, writer.actor, ids.alicePrivate, ids.aliceShared)).resolves.toMatchObject(
    {
      created: true,
    },
  );
  // A read-granted Agent sees the same Memories but may not write a Link.
  await expect(link(graph, reader.actor, ids.aliceShared, ids.alicePrivate)).resolves.toBeNull();
  await expect(unlink(graph, reader.actor, ids.alicePrivate, ids.aliceShared)).resolves.toBe(false);
  await expect(
    visibleLinks(graph, reader.actor).then((links) => links.map((edge) => edge.source)),
  ).resolves.toEqual([ids.alicePrivate]);
  // Alice's Agent is not Bob's: it may not use Bob's private Memory as a target.
  await expect(link(graph, writer.actor, ids.aliceShared, ids.bobPrivate)).resolves.toBeNull();
  await expect(unlink(graph, writer.actor, ids.alicePrivate, ids.aliceShared)).resolves.toBe(true);
  expect(await storedLinks(context)).toEqual([]);
});

test("a revoked grant or suspended Membership stops Link writes at the database", async () => {
  const { access, context, graph, ids } = await fixture();
  const writer = await agentActor(access, context.alice, "write");
  await expect(
    link(graph, writer.actor, ids.aliceShared, ids.aliceSharedTwo),
  ).resolves.toMatchObject({
    created: true,
  });

  await access.revokeAgentGrant(context.alice, writer.agent.id);
  // The Actor context outlives its credential check, so only RLS refuses it now.
  await expect(link(graph, writer.actor, ids.aliceShared, ids.alicePrivate)).resolves.toBeNull();
  await expect(unlink(graph, writer.actor, ids.aliceShared, ids.aliceSharedTwo)).resolves.toBe(
    false,
  );

  await expect(link(graph, context.bob, ids.bobShared, ids.bobPrivate)).resolves.toMatchObject({
    created: true,
  });
  await context.suspendMembership(context.bob);
  await expect(link(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toBeNull();
  await expect(unlink(graph, context.bob, ids.bobShared, ids.bobPrivate)).resolves.toBe(false);
  expect(await storedLinks(context)).toHaveLength(2);
});

/** The ids of the Links a Memory lists for an Actor, or null when it lists none. */
async function listedLinks(
  graph: Fixture["graph"],
  actor: ActorContext,
  memoryId: string,
  direction: "outbound" | "inbound",
) {
  const links = await graph.list(actor, { memoryId, direction });
  return links?.map((listed) => [listed.sourceMemoryId, listed.targetMemoryId]) ?? null;
}

test("a Link list shows a Link only when both its endpoints are visible", async () => {
  const { access, context, graph, ids, memories } = await fixture();
  await link(graph, context.alice, ids.aliceShared, ids.aliceSharedTwo);
  await link(graph, context.alice, ids.alicePrivate, ids.aliceSharedTwo);
  await link(graph, context.bob, ids.bobShared, ids.aliceSharedTwo);
  await link(graph, context.bob, ids.bobPrivate, ids.aliceSharedTwo);

  // Each owner sees their own private Link and every shared one, never the other's.
  await expect(listedLinks(graph, context.alice, ids.aliceSharedTwo, "inbound")).resolves.toEqual([
    [ids.bobShared, ids.aliceSharedTwo],
    [ids.alicePrivate, ids.aliceSharedTwo],
    [ids.aliceShared, ids.aliceSharedTwo],
  ]);
  await expect(listedLinks(graph, context.bob, ids.aliceSharedTwo, "inbound")).resolves.toEqual([
    [ids.bobPrivate, ids.aliceSharedTwo],
    [ids.bobShared, ids.aliceSharedTwo],
    [ids.aliceShared, ids.aliceSharedTwo],
  ]);
  // A Memory the Actor cannot see lists nothing, the same as a missing one.
  await expect(listedLinks(graph, context.bob, ids.alicePrivate, "outbound")).resolves.toBeNull();
  await expect(
    listedLinks(graph, context.bob, "40000000-0000-4000-8000-0000000000ff", "outbound"),
  ).resolves.toBeNull();
  // Another Workspace sees nothing, whether it names the Memory or binds to it.
  await expect(
    listedLinks(graph, context.carol, ids.aliceSharedTwo, "inbound"),
  ).resolves.toBeNull();
  const aliceInResearch = { ...context.alice, workspaceId: context.carol.workspaceId };
  await expect(
    listedLinks(graph, aliceInResearch, ids.aliceSharedTwo, "inbound"),
  ).resolves.toBeNull();

  // A read-granted Agent lists what its User sees; revoked, it lists nothing.
  const reader = await agentActor(access, context.alice, "read");
  await expect(listedLinks(graph, reader.actor, ids.alicePrivate, "outbound")).resolves.toEqual([
    [ids.alicePrivate, ids.aliceSharedTwo],
  ]);
  await access.revokeAgentGrant(context.alice, reader.agent.id);
  await expect(listedLinks(graph, reader.actor, ids.alicePrivate, "outbound")).resolves.toBeNull();

  // A source made private leaves the list for everyone but its owner.
  await memories.update(context.bob, ids.bobShared, { scope: "private" });
  await expect(listedLinks(graph, context.alice, ids.aliceSharedTwo, "inbound")).resolves.toEqual([
    [ids.alicePrivate, ids.aliceSharedTwo],
    [ids.aliceShared, ids.aliceSharedTwo],
  ]);
});

test("forgetting either endpoint removes the Link and refuses writes to it", async () => {
  const { context, graph, ids, memories } = await fixture();
  await link(graph, context.bob, ids.bobShared, ids.aliceShared);
  await link(graph, context.alice, ids.aliceSharedTwo, ids.alicePrivate);
  expect(await storedLinks(context)).toHaveLength(2);

  await memories.forget(context.alice, ids.aliceShared);
  await memories.forget(context.alice, ids.aliceSharedTwo);

  expect(await storedLinks(context)).toEqual([]);
  await expect(link(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toBeNull();
  await expect(unlink(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toBe(false);
  await expect(
    link(graph, context.alice, ids.aliceSharedTwo, ids.alicePrivate),
  ).resolves.toBeNull();
});

test("a target made private hides the Link from its author until it is shared again", async () => {
  const { context, graph, ids, memories } = await fixture();
  await expect(link(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toMatchObject({
    created: true,
  });

  await memories.update(context.alice, ids.aliceShared, { scope: "private" });

  expect(await visibleLinks(graph, context.bob)).toEqual([]);
  // Bob can neither rewrite nor delete a Link whose target he can no longer read,
  // and neither answer differs from a Link that does not exist.
  await expect(
    graph.connect(context.bob, {
      sourceMemoryId: ids.bobShared,
      targetMemoryId: ids.aliceShared,
      weight: 0.5,
    }),
  ).resolves.toBeNull();
  await expect(unlink(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toBe(false);
  expect(await storedLinks(context)).toEqual([
    { source: ids.bobShared, target: ids.aliceShared, weight: 1 },
  ]);

  await memories.update(context.alice, ids.aliceShared, { scope: "shared" });
  expect(await visibleLinks(graph, context.bob)).toEqual([
    expect.objectContaining({ source: ids.bobShared, target: ids.aliceShared }),
  ]);
  await expect(unlink(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toBe(true);
});

test("a source made private keeps its owner's authority and hides the Link from others", async () => {
  const { context, graph, ids, memories } = await fixture();
  await link(graph, context.alice, ids.aliceShared, ids.aliceSharedTwo);

  await memories.update(context.alice, ids.aliceShared, { scope: "private" });

  expect(await visibleLinks(graph, context.bob)).toEqual([]);
  await expect(link(graph, context.bob, ids.aliceShared, ids.aliceSharedTwo)).resolves.toBeNull();
  await expect(
    graph.connect(context.alice, {
      sourceMemoryId: ids.aliceShared,
      targetMemoryId: ids.aliceSharedTwo,
      weight: 0.25,
    }),
  ).resolves.toMatchObject({ created: false, link: { weight: 0.25 } });
  await expect(unlink(graph, context.alice, ids.aliceShared, ids.aliceSharedTwo)).resolves.toBe(
    true,
  );
});

/**
 * Run `interleave` inside the Link write's own transaction just before the statement
 * matching `statement` (the new-Link insert is the data-modifying CTE behind the counts),
 * which is where a concurrent READ COMMITTED writer's commit becomes visible. PGlite
 * has one session, so a real concurrent commit cannot be reproduced here.
 */
function interleaved(
  database: PostgresDatabase,
  statement: RegExp,
  interleave: (transaction: PostgresTransaction) => Promise<void>,
): PostgresDatabase {
  return {
    transaction: (use, options) =>
      database.transaction(
        (transaction) =>
          use(
            transactionThrough(transaction, async <Row>(sql: string, params?: unknown[]) => {
              if (statement.test(sql)) await interleave(transaction);
              return transaction.query<Row>(sql, params);
            }),
          ),
        options,
      ),
  };
}

test("a target made private after the lock but before the insert reads as missing", async () => {
  const { context, ids } = await fixture();
  const racing = createMemoryGraphModule(
    interleaved(context.database, /INSERT INTO memory_links/, async (transaction) => {
      // Alice's scope change commits between Bob's endpoint check and his insert.
      installActorContext(transaction, context.alice);
      await transaction.query("UPDATE memories SET scope = 'private' WHERE id = $1", [
        ids.aliceShared,
      ]);
      installActorContext(transaction, context.bob);
    }),
  );

  // The insert's RLS check refuses the row (42501), which reads as an absent target.
  await expect(link(racing, context.bob, ids.bobShared, ids.aliceShared)).resolves.toBeNull();
  expect(await storedLinks(context)).toEqual([]);
});

test("a target made private after the read but before the update reads as missing", async () => {
  const { context, graph, ids } = await fixture();
  await expect(link(graph, context.bob, ids.bobShared, ids.aliceShared)).resolves.toMatchObject({
    created: true,
  });
  const racing = createMemoryGraphModule(
    interleaved(context.database, /^\s*UPDATE memory_links/, async (transaction) => {
      // Alice's scope change commits between Bob's locked read and his update, which
      // RLS then filters to zero rows without an error.
      installActorContext(transaction, context.alice);
      await transaction.query("UPDATE memories SET scope = 'private' WHERE id = $1", [
        ids.aliceShared,
      ]);
      installActorContext(transaction, context.bob);
    }),
  );

  // Never the stale Link as a success: the replacement did not land.
  await expect(
    racing.connect(context.bob, {
      sourceMemoryId: ids.bobShared,
      targetMemoryId: ids.aliceShared,
      weight: 0.5,
    }),
  ).resolves.toBeNull();
  expect(await storedLinks(context)).toEqual([
    { source: ids.bobShared, target: ids.aliceShared, weight: 1 },
  ]);
});

test("a Link hidden from the first read by a flickering target is replaced, not a 500", async () => {
  const { context, graph, ids } = await fixture();
  await link(graph, context.bob, ids.bobShared, ids.aliceShared);
  const setTargetScope =
    (scope: "shared" | "private") => async (transaction: PostgresTransaction) => {
      installActorContext(transaction, context.alice);
      await transaction.query("UPDATE memories SET scope = $2 WHERE id = $1", [
        ids.aliceShared,
        scope,
      ]);
      installActorContext(transaction, context.bob);
    };
  let hidden = false;
  const flickering = createMemoryGraphModule(
    // Alice makes the target private just before Bob's Link read, and shared again
    // just before his insert, so the insert finds the natural key already taken.
    interleaved(
      interleaved(context.database, /INSERT INTO memory_links/, setTargetScope("shared")),
      /FROM memory_links\s+WHERE[\s\S]*FOR UPDATE/,
      async (transaction) => {
        if (hidden) return;
        hidden = true;
        await setTargetScope("private")(transaction);
      },
    ),
  );

  await expect(
    flickering.connect(context.bob, {
      sourceMemoryId: ids.bobShared,
      targetMemoryId: ids.aliceShared,
      weight: 0.5,
    }),
  ).resolves.toMatchObject({ created: false, link: { weight: 0.5 } });
  expect(await storedLinks(context)).toEqual([
    { source: ids.bobShared, target: ids.aliceShared, weight: 0.5 },
  ]);
});

test("a taken key whose Link is disconnected before the retry is created again, not a 404", async () => {
  const { context, graph, ids } = await fixture();
  await link(graph, context.bob, ids.bobShared, ids.aliceShared);
  const setTargetScope =
    (scope: "shared" | "private") => async (transaction: PostgresTransaction) => {
      installActorContext(transaction, context.alice);
      await transaction.query("UPDATE memories SET scope = $2 WHERE id = $1", [
        ids.aliceShared,
        scope,
      ]);
      installActorContext(transaction, context.bob);
    };
  let hidden = false;
  const flickering = interleaved(
    interleaved(context.database, /INSERT INTO memory_links/, setTargetScope("shared")),
    /FROM memory_links\s+WHERE[\s\S]*FOR UPDATE/,
    async (transaction) => {
      if (hidden) return;
      hidden = true;
      await setTargetScope("private")(transaction);
    },
  );
  // The first attempt finds the key taken and commits. Before the next one starts,
  // the Link it could not see is disconnected.
  let transactions = 0;
  const racing: PostgresDatabase = {
    async transaction(use, options) {
      transactions += 1;
      if (transactions === 2) await unlink(graph, context.bob, ids.bobShared, ids.aliceShared);
      return flickering.transaction(use, options);
    },
  };

  await expect(
    createMemoryGraphModule(racing).connect(context.bob, {
      sourceMemoryId: ids.bobShared,
      targetMemoryId: ids.aliceShared,
      weight: 0.5,
    }),
  ).resolves.toMatchObject({ created: true, link: { weight: 0.5 } });
  expect(await storedLinks(context)).toEqual([
    { source: ids.bobShared, target: ids.aliceShared, weight: 0.5 },
  ]);
});

test("a target deleted past the lock reads as missing, while any other failure surfaces", async () => {
  const { context, ids } = await fixture();
  const failing = (error: Error) =>
    createMemoryGraphModule(
      interleaved(context.database, /INSERT INTO memory_links/, async () => {
        throw error;
      }),
    );
  // A delete that commits after the insert's RLS check fails its foreign key instead.
  const foreignKey = Object.assign(new Error("violates foreign key constraint"), {
    code: "23503",
  });
  const uniqueKey = Object.assign(new Error("duplicate key value"), { code: "23505" });

  await expect(
    link(failing(foreignKey), context.alice, ids.aliceShared, ids.aliceSharedTwo),
  ).resolves.toBeNull();
  await expect(
    link(failing(uniqueKey), context.alice, ids.aliceShared, ids.aliceSharedTwo),
  ).rejects.toBe(uniqueKey);
  expect(await storedLinks(context)).toEqual([]);
});
