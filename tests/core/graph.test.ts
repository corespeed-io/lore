import type { MemoryGraph, PostgresDatabase, PostgresTransaction } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createAccessModule } from "@/server/auth/access";
import { createMemoryGraphModule } from "../../src/modules/graph/service";
import { createMemoryModule } from "../../src/modules/memories/service";
import type { MemoryTestContext } from "../support/memory-context";
import { createMemoryTestContext } from "../support/memory-context";

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

function fillerWords(word: string, characters: number): string {
  let text = "";
  for (let index = 0; text.length < characters; index += 1) {
    text += `${text ? " " : ""}${word}${index % 7}`;
  }
  return text.slice(0, characters);
}

async function seedGraphReadFixture(testContext: MemoryTestContext) {
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const fixture: Array<{ key: string; content: string; metadata?: Record<string, unknown> }> = [
    {
      key: "titled",
      content: "Orbital launch checklist for the shared mission.",
      metadata: { title: "  Launch\n checklist  ", reference: "launch/checklist", type: "plan" },
    },
    {
      key: "legacy",
      content: "Orbital launch timeline.\nSecond line of the timeline.",
      metadata: { legacy: { slug: "launch/timeline" } },
    },
    {
      key: "longLinked",
      content: `The first sentence names the reactor. ${fillerWords("reactor", 1_600)}.\nSecond line.`,
    },
    { key: "whitespace", content: `x${" ".repeat(1_500)}tail sentence.` },
    { key: "runOn", content: `${fillerWords("runon", 1_300)}. Final sentence.` },
    {
      key: "crlf",
      content: `${fillerWords("crlf", 1_000)}\r\nSecond line after a CRLF break.`,
    },
    { key: "blankFirstLine", content: `\n${fillerWords("blank", 1_400)}` },
    { key: "cjk", content: `北极星计划的发射窗口在周二。 ${"发射准备工作继续进行".repeat(120)}` },
    { key: "emoji", content: `${"🧭".repeat(1_200)} compass.` },
    { key: "isoA", content: "Telescope aperture calibration notes for the observatory." },
    { key: "isoB", content: "Observatory telescope aperture calibration schedule." },
    { key: "isoC", content: "Hydrology sediment basin cartography survey." },
    {
      key: "isoLong",
      content: `${fillerWords("quartz", 1_600)} hydrology sediment basin cartography.`,
    },
  ];
  const ids = new Map<string, string>();
  for (const [index, entry] of fixture.entries()) {
    const memory = await memories.remember(testContext.alice, {
      content: entry.content,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    });
    ids.set(entry.key, memory.id);
    await testContext.adminDatabase.transaction((transaction) =>
      transaction.query("UPDATE memories SET updated_at = $2 WHERE id = $1", [
        memory.id,
        `2026-03-01T00:${String(59 - index).padStart(2, "0")}:00.123456Z`,
      ]),
    );
  }
  const id = (key: string) => {
    const value = ids.get(key);
    if (!value) throw new Error(`Missing fixture Memory ${key}`);
    return value;
  };
  for (const [source, target] of [
    ["titled", "legacy"],
    ["titled", "longLinked"],
    ["legacy", "whitespace"],
    ["legacy", "runOn"],
    ["legacy", "crlf"],
    ["legacy", "blankFirstLine"],
    ["legacy", "cjk"],
    ["legacy", "emoji"],
  ] as const) {
    await graph.connect(testContext.alice, {
      sourceMemoryId: id(source),
      targetMemoryId: id(target),
      kind: "wikilink",
    });
  }
  const keys = new Map([...ids].map(([key, value]) => [value, key] as const));
  const key = (value: string) => keys.get(value) ?? value;
  return {
    id,
    content(key: string) {
      const entry = fixture.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`Missing fixture Memory ${key}`);
      return entry.content;
    },
    // Random Memory ids become fixture keys; affinity endpoints are id-sorted.
    normalize(result: MemoryGraph) {
      return {
        nodes: result.nodes.map(({ id: nodeId, reference, ...node }) => ({
          key: key(nodeId),
          reference: key(reference),
          ...node,
        })),
        links: result.links.map(({ source, target, ...link }) =>
          link.kind === "affinity"
            ? { pair: [key(source), key(target)].sort(), ...link }
            : { source: key(source), target: key(target), ...link },
        ),
      };
    },
  };
}

/** Wrap a database to record every string `content` column the graph read returns. */
function recordingDatabase(
  database: PostgresDatabase,
  afterQuery?: (transaction: PostgresTransaction, rows: unknown[]) => Promise<void>,
) {
  const contents: string[] = [];
  const recording: PostgresDatabase = {
    transaction: (use) =>
      database.transaction((transaction) =>
        use({
          async query<Row>(sql: string, params?: unknown[]) {
            const result = await transaction.query<Row>(sql, params);
            const rows: unknown[] = result.rows;
            for (const row of rows) {
              if (row && typeof row === "object" && "content" in row) {
                if (typeof row.content === "string") contents.push(row.content);
              }
            }
            await afterQuery?.(transaction, rows);
            return result;
          },
        }),
      ),
  };
  return { database: recording, contents };
}

// Captured from the full-content implementation this bounded read replaced.
const expectedFixtureNodes = [
  {
    key: "titled",
    reference: "launch/checklist",
    label: "Launch checklist",
    preview: "Orbital launch checklist for the shared mission.",
    scope: "shared",
    type: "plan",
    updatedAt: "2026-03-01T00:59:00.123Z",
  },
  {
    key: "legacy",
    reference: "launch/timeline",
    label: "Orbital launch timeline.",
    preview: "Orbital launch timeline. Second line of the timeline.",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:58:00.123Z",
  },
  {
    key: "longLinked",
    reference: "longLinked",
    label: "The first sentence names the reactor.",
    preview:
      "The first sentence names the reactor. reactor0 reactor1 reactor2 reactor3 reactor4 reactor5 reactor6 reactor0 reactor1 reactor2 reactor3 reactor4 reactor5 reactor6 reactor0 reactor1 reactor2 reactor3 reactor4 reactor5 reactor6 reactor0 rea…",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:57:00.123Z",
  },
  {
    key: "whitespace",
    reference: "whitespace",
    label: "x tail sentence.",
    preview: "x tail sentence.",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:56:00.123Z",
  },
  {
    key: "runOn",
    reference: "runOn",
    label: "runon0 runon1 runon2 runon3 runon4 runon5 runon6 runon0 runon1 runon2 r…",
    preview:
      "runon0 runon1 runon2 runon3 runon4 runon5 runon6 runon0 runon1 runon2 runon3 runon4 runon5 runon6 runon0 runon1 runon2 runon3 runon4 runon5 runon6 runon0 runon1 runon2 runon3 runon4 runon5 runon6 runon0 runon1 runon2 runon3 runon4 runon5 r…",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:55:00.123Z",
  },
  {
    key: "crlf",
    reference: "crlf",
    label: "crlf0 crlf1 crlf2 crlf3 crlf4 crlf5 crlf6 crlf0 crlf1 crlf2 crlf3 crlf4…",
    preview:
      "crlf0 crlf1 crlf2 crlf3 crlf4 crlf5 crlf6 crlf0 crlf1 crlf2 crlf3 crlf4 crlf5 crlf6 crlf0 crlf1 crlf2 crlf3 crlf4 crlf5 crlf6 crlf0 crlf1 crlf2 crlf3 crlf4 crlf5 crlf6 crlf0 crlf1 crlf2 crlf3 crlf4 crlf5 crlf6 crlf0 crlf1 crlf2 crlf3 crlf4…",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:54:00.123Z",
  },
  {
    key: "blankFirstLine",
    reference: "blankFirstLine",
    label: "blank0 blank1 blank2 blank3 blank4 blank5 blank6 blank0 blank1 blank2 b…",
    preview:
      "blank0 blank1 blank2 blank3 blank4 blank5 blank6 blank0 blank1 blank2 blank3 blank4 blank5 blank6 blank0 blank1 blank2 blank3 blank4 blank5 blank6 blank0 blank1 blank2 blank3 blank4 blank5 blank6 blank0 blank1 blank2 blank3 blank4 blank5 b…",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:53:00.123Z",
  },
  {
    key: "cjk",
    reference: "cjk",
    label: "北极星计划的发射窗口在周二。",
    preview: `北极星计划的发射窗口在周二。 ${"发射准备工作继续进行".repeat(22)}发射准备…`,
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:52:00.123Z",
  },
  {
    key: "emoji",
    reference: "emoji",
    // UTF-16 truncation keeps a lone high surrogate before the ellipsis.
    label: `${"🧭".repeat(35)}\ud83e…`,
    preview: `${"🧭".repeat(119)}\ud83e…`,
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:51:00.123Z",
  },
  {
    key: "isoA",
    reference: "isoA",
    label: "Telescope aperture calibration notes for the observatory.",
    preview: "Telescope aperture calibration notes for the observatory.",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:50:00.123Z",
  },
  {
    key: "isoB",
    reference: "isoB",
    label: "Observatory telescope aperture calibration schedule.",
    preview: "Observatory telescope aperture calibration schedule.",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:49:00.123Z",
  },
  {
    key: "isoC",
    reference: "isoC",
    label: "Hydrology sediment basin cartography survey.",
    preview: "Hydrology sediment basin cartography survey.",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:48:00.123Z",
  },
  {
    key: "isoLong",
    reference: "isoLong",
    label: "quartz0 quartz1 quartz2 quartz3 quartz4 quartz5 quartz6 quartz0 quartz1…",
    preview:
      "quartz0 quartz1 quartz2 quartz3 quartz4 quartz5 quartz6 quartz0 quartz1 quartz2 quartz3 quartz4 quartz5 quartz6 quartz0 quartz1 quartz2 quartz3 quartz4 quartz5 quartz6 quartz0 quartz1 quartz2 quartz3 quartz4 quartz5 quartz6 quartz0 quartz1…",
    scope: "shared",
    type: "shared",
    updatedAt: "2026-03-01T00:47:00.123Z",
  },
];

const expectedFixtureWikilinks = [
  ["titled", "legacy"],
  ["titled", "longLinked"],
  ["legacy", "whitespace"],
  ["legacy", "runOn"],
  ["legacy", "crlf"],
  ["legacy", "blankFirstLine"],
  ["legacy", "cjk"],
  ["legacy", "emoji"],
].map(([source, target]) => ({ source, target, kind: "wikilink", weight: 1 }));

test("Memory Graph reads bounded content without changing its nodes, labels, or affinities", async () => {
  const testContext = await createMemoryTestContext();
  const fixture = await seedGraphReadFixture(testContext);
  const recorded = recordingDatabase(testContext.database);

  const result = fixture.normalize(
    await createMemoryGraphModule(recorded.database).read(testContext.alice),
  );

  expect(result).toEqual({
    nodes: expectedFixtureNodes,
    links: [
      ...expectedFixtureWikilinks,
      { pair: ["isoA", "isoB"], kind: "affinity", weight: 0.8 },
      // The shared terms sit past the prefix, so this proves complete content.
      { pair: ["isoC", "isoLong"], kind: "affinity", weight: 0.5394 },
    ],
  });
  // Only an affinity candidate and a prefix that cannot decide its node text
  // return complete long content; every other node transfers a bounded prefix.
  const longContents = recorded.contents.filter((content) => Array.from(content).length > 1_001);
  expect(new Set(longContents)).toEqual(
    new Set([fixture.content("whitespace"), fixture.content("isoLong")]),
  );
});

test("Memory Graph rereads complete content when a needed Memory changes between statements", async () => {
  const testContext = await createMemoryTestContext();
  const fixture = await seedGraphReadFixture(testContext);
  let changed = false;
  const recorded = recordingDatabase(testContext.database, async (transaction, rows) => {
    const boundedRead = rows.some(
      (row) => row && typeof row === "object" && "content_complete" in row,
    );
    if (changed || !boundedRead) return;
    changed = true;
    // Stands in for a concurrent commit that the next statement's snapshot sees.
    await transaction.query(
      "UPDATE memories SET content = content || ' extra', version = version + 1 WHERE id = $1",
      [fixture.id("isoLong")],
    );
  });

  const result = fixture.normalize(
    await createMemoryGraphModule(recorded.database).read(testContext.alice),
  );

  expect(changed).toBe(true);
  expect(result).toEqual({
    nodes: expectedFixtureNodes,
    links: [
      ...expectedFixtureWikilinks,
      { pair: ["isoA", "isoB"], kind: "affinity", weight: 0.8 },
      { pair: ["isoC", "isoLong"], kind: "affinity", weight: 0.5164 },
    ],
  });
  expect(recorded.contents).toContain(fixture.content("longLinked"));
});
