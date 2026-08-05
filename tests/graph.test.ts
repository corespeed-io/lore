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
  await memories.remember(testContext.alice, { content: "Shared operating context." });

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
  expect(result.links).toHaveLength(1);
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
