import {
  MEMORY_GRAPH_LIMITS,
  MEMORY_LINK_LIMITS,
  type MemoryGraph,
  type PostgresDatabase,
  type PostgresTransaction,
} from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { MAX_WORKSPACE_ARCHIVE_LINKS } from "@/modules/portability/limits";
import { createMemoryGraphModule } from "../../src/modules/graph/service";
import { createMemoryModule } from "../../src/modules/memories/service";
import { createAccessModule } from "../support/access";
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
  ).resolves.toBeNull();
  await expect(
    graph.connect(testContext.alice, {
      sourceMemoryId: aliceMemory.id,
      targetMemoryId: researchMemory.id,
    }),
  ).resolves.toBeNull();
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

  await expect(graph.read(testContext.bob)).resolves.toEqual({
    nodes: [],
    links: [],
    linksTruncated: false,
  });
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
          link.derived
            ? { pair: [key(source), key(target)].sort(), ...link }
            : { source: key(source), target: key(target), ...link },
        ),
        linksTruncated: result.linksTruncated,
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
].map(([source, target]) => ({ source, target, kind: "wikilink", weight: 1, derived: false }));

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
      { pair: ["isoA", "isoB"], kind: "affinity", weight: 0.8, derived: true },
      // The shared terms sit past the prefix, so this proves complete content.
      { pair: ["isoC", "isoLong"], kind: "affinity", weight: 0.5394, derived: true },
    ],
    linksTruncated: false,
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
      { pair: ["isoA", "isoB"], kind: "affinity", weight: 0.8, derived: true },
      { pair: ["isoC", "isoLong"], kind: "affinity", weight: 0.5164, derived: true },
    ],
    linksTruncated: false,
  });
  expect(recorded.contents).toContain(fixture.content("longLinked"));
});

test("a Memory Link is one row per natural key, replaced in place and deleted by kind", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Release decision." });
  const target = await memories.remember(testContext.alice, { content: "Release evidence." });
  const endpoints = { sourceMemoryId: source.id, targetMemoryId: target.id };

  const created = await graph.connect(testContext.alice, { ...endpoints, metadata: { note: "a" } });
  const repeated = await graph.connect(testContext.alice, {
    ...endpoints,
    metadata: { note: "a" },
  });
  const replaced = await graph.connect(testContext.alice, { ...endpoints, weight: 0.5 });
  const cites = await graph.connect(testContext.alice, { ...endpoints, kind: "cites" });

  expect(created).toMatchObject({ created: true, link: { kind: "related", weight: 1 } });
  // The same values leave the Link untouched, updatedAt included.
  expect(repeated).toEqual({ created: false, link: created?.link });
  // A PUT replaces the whole Link: omitted metadata returns to its default.
  expect(replaced).toMatchObject({
    created: false,
    link: { id: created?.link.id, weight: 0.5, metadata: {} },
  });
  // Microsecond text sorts chronologically; two quick transactions may share a tick.
  expect((replaced?.link.updatedAt ?? "") >= (created?.link.updatedAt ?? "")).toBe(true);
  expect(cites).toMatchObject({ created: true, link: { kind: "cites" } });
  expect(cites?.link.id).not.toBe(created?.link.id);

  await expect(graph.disconnect(testContext.alice, endpoints)).resolves.toBe(true);
  await expect(graph.disconnect(testContext.alice, endpoints)).resolves.toBe(false);
  await expect(graph.read(testContext.alice)).resolves.toMatchObject({
    links: [expect.objectContaining({ source: source.id, target: target.id, kind: "cites" })],
  });
});

test("a Memory lists its outbound or inbound Links newest first, one page at a time", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const hub = await memories.remember(testContext.alice, { content: "Listed hub." });
  const others = [];
  for (const content of ["Listed one.", "Listed two.", "Listed three."]) {
    const other = await memories.remember(testContext.alice, { content });
    others.push(other.id);
    await graph.connect(testContext.alice, {
      sourceMemoryId: hub.id,
      targetMemoryId: other.id,
      metadata: { why: content },
    });
  }
  await graph.connect(testContext.alice, {
    sourceMemoryId: others[0] ?? "",
    targetMemoryId: hub.id,
  });

  const outbound = await graph.list(testContext.alice, { memoryId: hub.id });
  expect(outbound?.map((listed) => listed.targetMemoryId)).toEqual([...others].reverse());
  // Unlike a Graph Link, a listed Link carries its metadata.
  expect(outbound?.[0]).toMatchObject({
    workspaceId: testContext.alice.workspaceId,
    sourceMemoryId: hub.id,
    metadata: { why: "Listed three." },
  });
  await expect(
    graph.list(testContext.alice, { memoryId: hub.id, direction: "inbound" }),
  ).resolves.toMatchObject([{ sourceMemoryId: others[0], targetMemoryId: hub.id }]);

  // Pages continue after the last Link's (createdAt, id) and never repeat one.
  const first = await graph.list(testContext.alice, { memoryId: hub.id, limit: 2 });
  const last = first?.at(-1);
  if (!last) throw new Error("Expected a first page");
  const second = await graph.list(testContext.alice, {
    memoryId: hub.id,
    limit: 2,
    cursor: { createdAt: last.createdAt, id: last.id },
  });
  expect([...(first ?? []), ...(second ?? [])].map((listed) => listed.id)).toEqual(
    outbound?.map((listed) => listed.id),
  );

  const refused = [
    graph.list(testContext.alice, { memoryId: hub.id, limit: 0 }),
    graph.list(testContext.alice, {
      memoryId: hub.id,
      limit: MEMORY_LINK_LIMITS.maximumListLimit + 1,
    }),
    graph.list(testContext.alice, {
      memoryId: hub.id,
      direction: "sideways" as "outbound",
    }),
    graph.list(testContext.alice, {
      memoryId: hub.id,
      cursor: { createdAt: "not a time", id: hub.id },
    }),
  ];
  for (const [index, field] of ["limit", "limit", "direction", "cursor"].entries()) {
    await expect(refused[index]).rejects.toMatchObject({ name: "LoreValidationError", field });
  }
});

/** Seed Memories and Links past RLS, with row triggers off, for budget tests. */
async function seedPastRls(testContext: MemoryTestContext, sql: string, params: unknown[]) {
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query("SET LOCAL session_replication_role = replica");
    await transaction.query(sql, params);
  });
}

test("connect refuses a new Link past the per-pair kind bound, never a replacement", async () => {
  // The pair is directed: the reverse direction below is a pair of its own.
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Pair source." });
  const target = await memories.remember(testContext.alice, { content: "Pair target." });
  const endpoints = { sourceMemoryId: source.id, targetMemoryId: target.id };
  for (let index = 0; index < MEMORY_LINK_LIMITS.maximumKindsPerPair; index += 1) {
    await graph.connect(testContext.alice, { ...endpoints, kind: `kind-${index}` });
  }

  await expect(
    graph.connect(testContext.alice, { ...endpoints, kind: "one-too-many" }),
  ).rejects.toMatchObject({ name: "MemoryLinkCapacityError", limit: "maximumKindsPerPair" });
  // Rewriting a Link that already exists adds none, so the bound does not apply.
  await expect(
    graph.connect(testContext.alice, { ...endpoints, kind: "kind-0", weight: 0.5 }),
  ).resolves.toMatchObject({ created: false, link: { weight: 0.5 } });
  // The reverse direction is another pair, and freeing a kind makes room again.
  await expect(
    graph.connect(testContext.alice, { sourceMemoryId: target.id, targetMemoryId: source.id }),
  ).resolves.toMatchObject({ created: true });
  await graph.disconnect(testContext.alice, { ...endpoints, kind: "kind-0" });
  await expect(
    graph.connect(testContext.alice, { ...endpoints, kind: "one-too-many" }),
  ).resolves.toMatchObject({ created: true });
});

/** Seed `count` Memories past RLS, each linked to (or from) `anchor`. */
async function seedLinkedMemories(
  testContext: MemoryTestContext,
  anchor: string,
  count: number,
  direction: "from" | "to",
) {
  const [source, target] = direction === "from" ? ["$3", "id"] : ["id", "$3"];
  await seedPastRls(
    testContext,
    `WITH seeded AS (
       INSERT INTO memories (id, workspace_id, owner_user_id, content)
       SELECT gen_random_uuid(), $1, $2, 'Seeded Memory ' || index
       FROM generate_series(1, $4::integer) AS index
       RETURNING id
     )
     INSERT INTO memory_links (id, workspace_id, source_memory_id, target_memory_id, kind)
     SELECT gen_random_uuid(), $1, ${source}, ${target}, 'related' FROM seeded`,
    [testContext.alice.workspaceId, testContext.alice.userId, anchor, count],
  );
}

test("connect creates a source's last allowed Link and refuses the next", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Busy source." });
  const extra = await memories.remember(testContext.alice, { content: "One more target." });
  await seedLinkedMemories(
    testContext,
    source.id,
    MEMORY_LINK_LIMITS.maximumLinksPerSource - 1,
    "from",
  );
  const endpoints = { sourceMemoryId: source.id, targetMemoryId: extra.id };

  await expect(graph.connect(testContext.alice, endpoints)).resolves.toMatchObject({
    created: true,
  });
  await expect(
    graph.connect(testContext.alice, { ...endpoints, kind: "cites" }),
  ).rejects.toMatchObject({ name: "MemoryLinkCapacityError", limit: "maximumLinksPerSource" });
  // Another source is unaffected.
  await expect(
    graph.connect(testContext.alice, { sourceMemoryId: extra.id, targetMemoryId: source.id }),
  ).resolves.toMatchObject({ created: true });
});

test("connect refuses one owner's next Link to a target, never another owner's", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const hub = await memories.remember(testContext.alice, { content: "Popular hub." });
  const source = await memories.remember(testContext.alice, { content: "Late source." });
  const bobSource = await memories.remember(testContext.bob, { content: "Bob's source." });
  await seedLinkedMemories(testContext, hub.id, MEMORY_LINK_LIMITS.maximumLinksPerTarget, "to");

  await expect(
    graph.connect(testContext.alice, { sourceMemoryId: source.id, targetMemoryId: hub.id }),
  ).rejects.toMatchObject({ name: "MemoryLinkCapacityError", limit: "maximumLinksPerTarget" });
  // Alice's Links use only Alice's share of the hub, so Bob may still link to it.
  await expect(
    graph.connect(testContext.bob, { sourceMemoryId: bobSource.id, targetMemoryId: hub.id }),
  ).resolves.toMatchObject({ created: true });
  // The hub may still link out, and the late source may link elsewhere.
  await expect(
    graph.connect(testContext.alice, { sourceMemoryId: hub.id, targetMemoryId: source.id }),
  ).resolves.toMatchObject({ created: true });
});

test("connect refuses one owner's Link past their Workspace total, never another owner's", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const [first, second, third, fourth] = await Promise.all(
    ["First.", "Second.", "Third.", "Fourth."].map((content) =>
      memories.remember(testContext.alice, { content }),
    ),
  );
  if (!first || !second || !third || !fourth) throw new Error("Expected four Memories");
  const bobSource = await memories.remember(testContext.bob, { content: "Bob's source." });
  // One owner's Links alone always fit one Workspace archive.
  expect(MEMORY_LINK_LIMITS.maximumLinksPerOwner).toBe(MAX_WORKSPACE_ARCHIVE_LINKS);
  await seedPastRls(
    testContext,
    `INSERT INTO memory_links (id, workspace_id, source_memory_id, target_memory_id, kind)
     SELECT gen_random_uuid(), $1, $2, $3, 'kind-' || index
     FROM generate_series(1, $4::integer) AS index`,
    [testContext.alice.workspaceId, first.id, second.id, MEMORY_LINK_LIMITS.maximumLinksPerOwner],
  );

  await expect(
    graph.connect(testContext.alice, { sourceMemoryId: third.id, targetMemoryId: fourth.id }),
  ).rejects.toMatchObject({ name: "MemoryLinkCapacityError", limit: "maximumLinksPerOwner" });
  // Bob's Links count against Bob's own total, even to Alice's Memories.
  await expect(
    graph.connect(testContext.bob, { sourceMemoryId: bobSource.id, targetMemoryId: fourth.id }),
  ).resolves.toMatchObject({ created: true });
  // Replacing one of Alice's Links adds none, so her total does not apply.
  await expect(
    graph.connect(testContext.alice, {
      sourceMemoryId: first.id,
      targetMemoryId: second.id,
      kind: "kind-1",
      weight: 0.5,
    }),
  ).resolves.toMatchObject({ created: false, link: { weight: 0.5 } });
});

test("a Graph read past the link budget keeps the newest Links, says so, and derives none", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Crowded source." });
  const target = await memories.remember(testContext.alice, { content: "Crowded target." });
  // Two isolated Memories that would otherwise receive an affinity edge.
  await memories.remember(testContext.alice, { content: "Orbital launch checklist review." });
  await memories.remember(testContext.alice, { content: "Orbital launch checklist signoff." });
  // kind-0 is the oldest and kind-<maximumLinks> the newest.
  await seedPastRls(
    testContext,
    `INSERT INTO memory_links (id, workspace_id, source_memory_id, target_memory_id, kind, metadata, created_at)
     SELECT gen_random_uuid(), $1, $2, $3, 'kind-' || index, '{"bulk": true}',
            now() - make_interval(secs => $4::integer - index)
     FROM generate_series(0, $4::integer) AS index`,
    [testContext.alice.workspaceId, source.id, target.id, MEMORY_GRAPH_LIMITS.maximumLinks],
  );

  const cut = await graph.read(testContext.alice);

  expect(cut.linksTruncated).toBe(true);
  expect(cut.links).toHaveLength(MEMORY_GRAPH_LIMITS.maximumLinks);
  expect(cut.links.every((link) => !link.derived)).toBe(true);
  // The oldest Link is the one cut; the rest arrive in creation order.
  expect(cut.links.at(0)?.kind).toBe("kind-1");
  expect(cut.links.at(-1)?.kind).toBe(`kind-${MEMORY_GRAPH_LIMITS.maximumLinks}`);
  // A Graph Link carries no metadata, whatever the stored Link holds.
  expect(Object.keys(cut.links[0] ?? {}).sort()).toEqual([
    "derived",
    "kind",
    "source",
    "target",
    "weight",
  ]);

  // Exactly the budget is complete: nothing is cut, and affinity returns.
  await seedPastRls(testContext, "DELETE FROM memory_links WHERE kind = 'kind-0'", []);
  const complete = await graph.read(testContext.alice);

  expect(complete.linksTruncated).toBe(false);
  expect(complete.links.filter((link) => !link.derived)).toHaveLength(
    MEMORY_GRAPH_LIMITS.maximumLinks,
  );
  expect(complete.links.some((link) => link.derived)).toBe(true);
});

test("a Graph read past the link budget takes each owner's newest Links in turn", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Prolific source." });
  const target = await memories.remember(testContext.alice, { content: "Shared target." });
  const bobSource = await memories.remember(testContext.bob, { content: "Quiet source." });
  // Bob's three Links are older than every one of Alice's budget-and-more.
  await seedPastRls(
    testContext,
    `INSERT INTO memory_links (id, workspace_id, source_memory_id, target_memory_id, kind, created_at)
     SELECT gen_random_uuid(), $1, $2, $3, 'bob-' || index, now() - interval '1 day' + make_interval(secs => index)
     FROM generate_series(1, 3) AS index`,
    [testContext.alice.workspaceId, bobSource.id, target.id],
  );
  await seedPastRls(
    testContext,
    `INSERT INTO memory_links (id, workspace_id, source_memory_id, target_memory_id, kind, created_at)
     SELECT gen_random_uuid(), $1, $2, $3, 'alice-' || index,
            now() - make_interval(secs => $4::integer - index)
     FROM generate_series(1, $4::integer) AS index`,
    [testContext.alice.workspaceId, source.id, target.id, MEMORY_GRAPH_LIMITS.maximumLinks + 1],
  );

  for (const reader of [testContext.alice, testContext.bob]) {
    const cut = await graph.read(reader);
    const kinds = cut.links.map((link) => link.kind);

    expect(cut.linksTruncated).toBe(true);
    expect(cut.links).toHaveLength(MEMORY_GRAPH_LIMITS.maximumLinks);
    // Newest-first alone would cut Bob's three; turns keep them and cut Alice's oldest.
    expect(kinds.slice(0, 4)).toEqual(["bob-1", "bob-2", "bob-3", "alice-5"]);
    expect(kinds.at(-1)).toBe(`alice-${MEMORY_GRAPH_LIMITS.maximumLinks + 1}`);
  }
});

test("a durable Link named affinity is still a durable Link", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Named source." });
  const target = await memories.remember(testContext.alice, { content: "Named target." });
  await graph.connect(testContext.alice, {
    sourceMemoryId: source.id,
    targetMemoryId: target.id,
    kind: "affinity",
  });

  await expect(graph.read(testContext.alice)).resolves.toMatchObject({
    links: [{ source: source.id, target: target.id, kind: "affinity", derived: false }],
    linksTruncated: false,
  });
});
