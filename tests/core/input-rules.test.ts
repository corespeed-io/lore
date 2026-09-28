import { LoreValidationError, MEMORY_LINK_LIMITS } from "@corespeed/lore-core";
import { afterEach, expect, test } from "vitest";
import { createObservationModule } from "@/modules/episodes/service";
import { createMemoryGraphModule } from "@/modules/graph/service";
import { createMemoryModule } from "@/modules/memories/service";
import { createApi } from "@/server/api/app";
import { createMemoryTestContext } from "../support/memory-context";

/**
 * The engine owns its input rules and refuses a value outside them with
 * LoreValidationError, naming the field. It never clamps or trims a value into
 * range, so a direct engine caller sees the same rule an HTTP client does.
 */

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

async function rejection(promise: Promise<unknown>): Promise<LoreValidationError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(LoreValidationError);
  return error as LoreValidationError;
}

test("list and search bounds are refused, not clamped", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  await memories.remember(testContext.alice, { content: "A bounded fact." });

  for (const [input, field] of [
    [{ limit: 0 }, "limit"],
    [{ limit: 101 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ offset: -1 }, "offset"],
    [{ offset: 1_000_001 }, "offset"],
  ] as const) {
    expect((await rejection(memories.list(testContext.alice, input))).field).toBe(field);
  }
  expect(
    (await rejection(memories.search(testContext.alice, { query: "fact", limit: 101 }))).field,
  ).toBe("limit");
  expect(
    (await rejection(memories.search(testContext.alice, { query: "q".repeat(10_001) }))).field,
  ).toBe("query");
  await expect(memories.list(testContext.alice, { limit: 100 })).resolves.toHaveLength(1);
  await testContext.close();
});

test("metadata is one bounded JSON object wherever the engine stores or filters it", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const oversized = { note: "m".repeat(100_000) };

  expect(
    (await rejection(memories.remember(testContext.alice, { content: "x", metadata: oversized })))
      .field,
  ).toBe("metadata");
  const memory = await memories.remember(testContext.alice, { content: "Metadata target." });
  expect(
    (
      await rejection(
        memories.update(testContext.alice, memory.id, {
          metadata: ["not", "an", "object"] as unknown as Record<string, unknown>,
        }),
      )
    ).field,
  ).toBe("metadata");
  expect(
    (await rejection(memories.list(testContext.alice, { metadataFilter: oversized }))).field,
  ).toBe("metadataFilter");
  // PostgreSQL refuses these in JSONB; the engine names the field instead.
  for (const metadata of [{ note: "bad\u0000" }, { "key\uD83D": "value" }]) {
    expect(
      (await rejection(memories.remember(testContext.alice, { content: "x", metadata }))).message,
    ).toBe("metadata contains a NUL character or invalid Unicode");
  }
  await testContext.close();
});

test("Memory Links are stored exactly as given or refused", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Link source." });
  const target = await memories.remember(testContext.alice, { content: "Link target." });
  const connect = (input: { kind?: string; weight?: number; targetMemoryId?: string }) =>
    graph.connect(testContext.alice, {
      sourceMemoryId: source.id,
      targetMemoryId: input.targetMemoryId ?? target.id,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.weight === undefined ? {} : { weight: input.weight }),
    });

  expect(
    (await rejection(connect({ kind: "k".repeat(MEMORY_LINK_LIMITS.maximumKindLength + 1) })))
      .field,
  ).toBe("link.kind");
  expect((await rejection(connect({ kind: "   " }))).field).toBe("link.kind");
  expect((await rejection(connect({ kind: "cites\uD83D" }))).field).toBe("link.kind");
  expect((await rejection(connect({ weight: 1.5 }))).field).toBe("link.weight");
  expect((await rejection(connect({ weight: Number.NaN }))).field).toBe("link.weight");
  expect((await rejection(connect({ targetMemoryId: source.id }))).field).toBe("link");
  // Link metadata has its own bound, far below a Memory's; `{"note":"…"}` adds 11.
  const note = (length: number) => ({ note: "m".repeat(length - 11) });
  const bound = MEMORY_LINK_LIMITS.maximumMetadataSerializedLength;
  const oversized = await rejection(
    graph.connect(testContext.alice, {
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      metadata: note(bound + 1),
    }),
  );
  expect([oversized.field, oversized.message]).toEqual([
    "link.metadata",
    `link.metadata exceeds ${bound} characters`,
  ]);
  await expect(
    graph.connect(testContext.alice, {
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      kind: "at-bound",
      metadata: note(bound),
    }),
  ).resolves.toMatchObject({ created: true });

  await expect(connect({})).resolves.toMatchObject({ link: { kind: "related", weight: 1 } });
  await expect(connect({ kind: " cites ", weight: 0.25 })).resolves.toMatchObject({
    link: { kind: " cites ", weight: 0.25 },
  });
  // The natural key is exact: a differently spaced kind is a different Link.
  await expect(
    graph.disconnect(testContext.alice, {
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      kind: "cites",
    }),
  ).resolves.toBe(false);
  await testContext.close();
});

test("Memory Link deletion is refused by the same key rules as creation", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const graph = createMemoryGraphModule(testContext.database);
  const source = await memories.remember(testContext.alice, { content: "Unlink source." });
  const target = await memories.remember(testContext.alice, { content: "Unlink target." });
  const disconnect = (input: { kind?: string; targetMemoryId?: string }) =>
    graph.disconnect(testContext.alice, {
      sourceMemoryId: source.id,
      targetMemoryId: input.targetMemoryId ?? target.id,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    });

  // UUIDs compare as PostgreSQL compares them, so case does not make a new endpoint.
  expect((await rejection(disconnect({ targetMemoryId: source.id.toUpperCase() }))).field).toBe(
    "link",
  );
  expect((await rejection(disconnect({ kind: "\t" }))).field).toBe("link.kind");
  expect((await rejection(disconnect({ kind: "cites\u0000" }))).field).toBe("link.kind");
  expect(
    (await rejection(disconnect({ kind: "k".repeat(MEMORY_LINK_LIMITS.maximumKindLength + 1) })))
      .field,
  ).toBe("link.kind");
  // A kind at the bound is a valid key, and no such Link exists.
  await expect(
    disconnect({ kind: "k".repeat(MEMORY_LINK_LIMITS.maximumKindLength) }),
  ).resolves.toBe(false);
  await testContext.close();
});

test("a Graph read outside its node budget is refused", async () => {
  const testContext = await createMemoryTestContext();
  const graph = createMemoryGraphModule(testContext.database);
  for (const limit of [0, 5_001]) {
    expect((await rejection(graph.read(testContext.alice, { limit }))).field).toBe("limit");
  }
  await expect(graph.read(testContext.alice, { limit: 5_000 })).resolves.toMatchObject({
    nodes: [],
  });
  await testContext.close();
});

test("Episode admission rules belong to the engine", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const record = (observation: Record<string, unknown>, kind = "conversation") =>
    observations.record(testContext.alice, {
      kind: kind as "conversation",
      observations: [
        { kind: "message", content: "Recorded evidence.", ...observation } as {
          kind: "message";
          content: string;
        },
      ],
    });

  expect((await rejection(record({}, "diary"))).field).toBe("kind");
  expect((await rejection(record({ kind: "thought" }))).field).toBe("observations[0].kind");
  expect((await rejection(record({ content: "bad\u0000" }))).field).toBe("observations[0].content");
  expect((await rejection(record({ metadata: { note: "m".repeat(100_000) } }))).field).toBe(
    "observations[0].metadata",
  );
  await expect(record({ metadata: { note: "fits" } })).resolves.toMatchObject({
    observations: [{ metadata: { note: "fits" } }],
  });
  await testContext.close();
});

test("HTTP maps every engine rule to 400 invalid_request", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "input-rules-http";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Input Rules" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  // A Graph limit beyond the published maximum was silently clamped before.
  const graph = await app.request(
    new Request("http://lore.local/api/v1/graph?limit=99999", { headers }),
  );
  expect(graph.status).toBe(400);
  await expect(graph.json()).resolves.toMatchObject({ code: "invalid_request" });
  // Zero was clamped to one and a non-number fell back to the maximum before.
  for (const limit of ["0", "abc", "2.5"]) {
    const refused = await app.request(
      new Request(`http://lore.local/api/v1/graph?limit=${limit}`, { headers }),
    );
    expect(refused.status, limit).toBe(400);
    await expect(refused.json()).resolves.toEqual({
      code: "invalid_request",
      error: "limit must be an integer from 1 to 5000",
    });
  }
  // An omitted or empty limit reads the whole budget.
  for (const query of ["", "?limit="]) {
    const read = await app.request(
      new Request(`http://lore.local/api/v1/graph${query}`, { headers }),
    );
    expect(read.status, query).toBe(200);
  }

  // The route checks only wire shapes; the engine refuses the per-Observation bound.
  const episode = await app.request(
    new Request("http://lore.local/api/v1/episodes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "conversation",
        observations: [{ kind: "message", content: "x".repeat(100_001) }],
      }),
    }),
  );
  expect(episode.status).toBe(400);
  await expect(episode.json()).resolves.toMatchObject({
    code: "invalid_request",
    error: "observations[0].content must contain 1 to 100000 characters",
  });
  await testContext.close();
});
