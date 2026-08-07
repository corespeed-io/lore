import { expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import { createMemoryGraphModule } from "@/lib/graph";
import { createMemoryModule } from "@/lib/memory";
import { createMemoryTestContext } from "./support/memory-context";

test("Memory Graph derives affinity only between visible Memories", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const shared = await memories.remember(testContext.alice, {
    content: "Orbital launch checklist for the shared mission.",
  });
  const alicePrivate = await memories.remember(testContext.alice, {
    content: "Alice private orbital launch concern.",
    scope: "private",
  });
  const bobPrivate = await memories.remember(testContext.bob, {
    content: "Bob private orbital launch timeline.",
    scope: "private",
  });
  await memories.remember(testContext.carol, {
    content: "Research workspace orbital launch notes.",
  });

  const result = await graph.read(testContext.bob);
  const nodeIds = new Set(result.nodes.map((node) => node.id));

  expect(nodeIds).toEqual(new Set([shared.id, bobPrivate.id]));
  expect(nodeIds.has(alicePrivate.id)).toBe(false);
  expect(result.links).toHaveLength(1);
  expect(result.links[0]).toMatchObject({
    source: [shared.id, bobPrivate.id].sort()[0],
    target: [shared.id, bobPrivate.id].sort()[1],
    kind: "affinity",
  });
  expect(result.links.every((link) => nodeIds.has(link.source) && nodeIds.has(link.target))).toBe(
    true,
  );
});

test("Memory Graph returns a durable directed Memory Link instead of affinity", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, {
    content: "Orbital launch checklist for the shared mission.",
    metadata: { title: "Launch checklist", reference: "launch/checklist" },
  });
  const target = await memories.remember(testContext.alice, {
    content: "Orbital launch timeline for the shared mission.",
    metadata: { title: "Launch timeline", legacy: { slug: "launch/timeline" } },
  });

  await graph.connect(testContext.alice, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "wikilink",
    metadata: { source: "test" },
  });
  const result = await graph.read(testContext.alice);

  expect(result.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: source.id,
        label: "Launch checklist",
        reference: "launch/checklist",
      }),
      expect.objectContaining({
        id: target.id,
        label: "Launch timeline",
        reference: "launch/timeline",
      }),
    ]),
  );
  expect(result.links).toEqual([
    expect.objectContaining({
      source: source.id,
      target: target.id,
      kind: "wikilink",
      weight: 1,
    }),
  ]);
});

test("Memory Link RLS hides a private endpoint and its relationship", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const shared = await memories.remember(testContext.alice, {
    content: "Shared incident plan.",
  });
  const alicePrivate = await memories.remember(testContext.alice, {
    content: "Alice private incident detail.",
    scope: "private",
  });
  await graph.connect(testContext.alice, {
    sourceMemoryId: shared.id,
    targetMemoryId: alicePrivate.id,
    kind: "wikilink",
  });

  await expect(graph.read(testContext.alice)).resolves.toMatchObject({
    nodes: expect.arrayContaining([
      expect.objectContaining({ id: shared.id }),
      expect.objectContaining({ id: alicePrivate.id }),
    ]),
    links: [expect.objectContaining({ source: shared.id, target: alicePrivate.id })],
  });
  await expect(graph.read(testContext.bob)).resolves.toMatchObject({
    nodes: [expect.objectContaining({ id: shared.id })],
    links: [],
  });
});

test("Memory Link appears after both endpoints become visible", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, {
    content: "Shared launch decision.",
  });
  const target = await memories.remember(testContext.alice, {
    content: "Private launch rationale.",
    scope: "private",
  });
  await graph.connect(testContext.alice, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "semantic",
  });

  expect((await graph.read(testContext.bob)).links).toEqual([]);
  await memories.update(testContext.alice, target.id, { scope: "shared" });
  await expect(graph.read(testContext.bob)).resolves.toMatchObject({
    links: [expect.objectContaining({ source: source.id, target: target.id, kind: "semantic" })],
  });
});

test("Deleting either endpoint cascades its Memory Links", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Source Memory." });
  const target = await memories.remember(testContext.alice, { content: "Target Memory." });
  await graph.connect(testContext.alice, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "wikilink",
  });

  await memories.forget(testContext.alice, target.id);

  await expect(graph.read(testContext.alice)).resolves.toMatchObject({
    nodes: [expect.objectContaining({ id: source.id })],
    links: [],
  });
});

test("Memory Link creation rejects invisible and cross-Workspace targets", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const aliceMemory = await memories.remember(testContext.alice, {
    content: "Operations source.",
  });
  const bobPrivate = await memories.remember(testContext.bob, {
    content: "Bob private target.",
    scope: "private",
  });
  const researchMemory = await memories.remember(testContext.carol, {
    content: "Research target.",
  });

  await expect(
    graph.connect(testContext.alice, {
      sourceMemoryId: aliceMemory.id,
      targetMemoryId: bobPrivate.id,
    }),
  ).rejects.toThrow();
  await expect(
    graph.connect(testContext.alice, {
      sourceMemoryId: aliceMemory.id,
      targetMemoryId: researchMemory.id,
    }),
  ).rejects.toThrow();
});

test("Memory Graph reflects scope changes without stale links", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const shared = await memories.remember(testContext.alice, {
    content: "Launch readiness decision for operations.",
  });
  const bobPrivate = await memories.remember(testContext.bob, {
    content: "Private launch readiness concern for operations.",
    scope: "private",
  });

  await expect(graph.read(testContext.bob)).resolves.toMatchObject({
    nodes: expect.arrayContaining([
      expect.objectContaining({ id: shared.id }),
      expect.objectContaining({ id: bobPrivate.id }),
    ]),
    links: [expect.objectContaining({ kind: "affinity" })],
  });

  await memories.update(testContext.alice, shared.id, { scope: "private" });
  const after = await graph.read(testContext.bob);

  expect(after.nodes.map((node) => node.id)).toEqual([bobPrivate.id]);
  expect(after.links).toEqual([]);
});

test("Suspended Membership removes every Memory Graph node and link", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, {
    content: "Shared operating context.",
  });
  const target = await memories.remember(testContext.alice, {
    content: "Shared operating decision.",
  });
  await graph.connect(testContext.alice, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "wikilink",
  });

  await testContext.suspendMembership(testContext.bob);

  await expect(graph.read(testContext.bob)).resolves.toEqual({ nodes: [], links: [] });
});

test("A permitted Agent receives its owner's private Memory Graph", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const first = await memories.remember(testContext.alice, {
    content: "Alice private launch preference.",
    scope: "private",
  });
  const second = await memories.remember(testContext.alice, {
    content: "Alice private launch schedule.",
    scope: "private",
  });
  await graph.connect(testContext.alice, {
    sourceMemoryId: first.id,
    targetMemoryId: second.id,
    kind: "wikilink",
  });
  const reader = await access.createAgent(testContext.alice, { name: "Reader" });
  await access.grantAgent(testContext.alice, reader.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, reader.id);
  const readerActor = await access.authenticateAgent(
    credential.token,
    testContext.alice.workspaceId,
  );
  if (!readerActor) throw new Error("Agent authentication failed in fixture");

  const result = await graph.read(readerActor);

  expect(new Set(result.nodes.map((node) => node.id))).toEqual(new Set([first.id, second.id]));
  expect(result.links).toEqual([
    expect.objectContaining({ source: first.id, target: second.id, kind: "wikilink" }),
  ]);
});

test("Memory Graph enforces the per-node affinity budget", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  for (let index = 0; index < 8; index += 1) {
    await memories.remember(testContext.alice, {
      content: `Shared launch planning retrieval graph isolation checklist item ${index}.`,
    });
  }

  const result = await graph.read(testContext.alice, {
    maxNeighbors: 3,
    minimumAffinity: 0,
  });
  const degrees = new Map<string, number>();
  for (const link of result.links) {
    degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1);
    degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1);
  }

  expect(Math.max(...degrees.values())).toBeLessThanOrEqual(3);
});
