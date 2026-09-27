import { describe, expect, test } from "vitest";
import {
  createEpisodeEvidenceModule,
  createObservationModule,
  MAX_EPISODE_CONTENT_CHARACTERS,
  MAX_EPISODE_OBSERVATIONS,
  MAX_OBSERVATION_BATCH_READ,
  normalizedEpisode,
  type RecordEpisode,
} from "../src/episodes/index";
import {
  boundedInteger,
  boundedNumber,
  createMemoryModule,
  createMemoryMutationPrimitives,
  insertMemoryLinksInTransaction,
  LoreConfigurationError,
  LoreValidationError,
  MEMORY_METADATA_LIMITS,
  MemoryContentValidationError,
  type MemoryStorageContext,
  memoryContentChunks,
  type PostgresTransaction,
  prepareMemoryContent,
  queryInRecordBatches,
  RECORD_BATCH_LIMITS,
  validateMemoryLink,
  validateMemoryMetadata,
} from "../src/index";

/** The validation failure `run` throws, which must be a LoreValidationError. */
function refusal(run: () => unknown): LoreValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LoreValidationError);
    return error as LoreValidationError;
  }
  throw new Error("Expected a LoreValidationError");
}

async function asyncRefusal(promise: Promise<unknown>): Promise<LoreValidationError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(LoreValidationError);
  return error as LoreValidationError;
}

/** A store that fails the test if the engine opens a transaction. */
const untouchedStorage: MemoryStorageContext = {
  partitionId: "20000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000001",
  database: {
    transaction: () => Promise.reject(new Error("the engine must refuse before any query")),
  },
};

describe("queryInRecordBatches", () => {
  function recordingTransaction() {
    const batches: Array<{ records: Array<{ n: number }>; parameters: unknown[] }> = [];
    const transaction: PostgresTransaction = {
      query: async <Row>(_sql: string, params: unknown[] = []) => {
        const [json, ...parameters] = params;
        const records = JSON.parse(json as string) as Array<{ n: number }>;
        batches.push({ records, parameters });
        return { rows: records.map((record) => ({ id: String(record.n) })) as Row[] };
      },
    };
    return { batches, transaction };
  }

  test("a batch closes at the row bound and returns every row in order", async () => {
    const { batches, transaction } = recordingTransaction();
    // An empty record list runs no statement.
    await expect(queryInRecordBatches(transaction, "SELECT 1", [])).resolves.toEqual([]);
    expect(batches).toEqual([]);
    const records = Array.from({ length: RECORD_BATCH_LIMITS.maximumRows + 1 }, (_, n) => ({
      n,
    }));
    const rows = await queryInRecordBatches(transaction, "INSERT ...", records, ["p2", "p3"]);

    expect(batches.map((batch) => batch.records.length)).toEqual([
      RECORD_BATCH_LIMITS.maximumRows,
      1,
    ]);
    // Every batch receives the shared parameters after its own JSON array.
    expect(batches.every((batch) => batch.parameters.join() === "p2,p3")).toBe(true);
    expect(rows.map((row) => Number(row.id))).toEqual(records.map((record) => record.n));
  });

  test("a batch closes before it would exceed the character bound", async () => {
    const { batches, transaction } = recordingTransaction();
    const padding = "x".repeat(Math.floor(RECORD_BATCH_LIMITS.maximumCharacters / 2));
    // Two of these cannot share one batch; a record larger than the bound goes alone.
    const records = [
      { n: 0, padding },
      { n: 1, padding },
      { n: 2, padding: "y".repeat(RECORD_BATCH_LIMITS.maximumCharacters + 1) },
      { n: 3 },
    ];
    await queryInRecordBatches(transaction, "INSERT ...", records);
    expect(batches.map((batch) => batch.records.map((record) => record.n))).toEqual([
      [0],
      [1],
      [2],
      [3],
    ]);
  });
});

describe("shared input rules", () => {
  test("metadata must be one storable JSON object within its serialized bound", () => {
    for (const value of [null, undefined, "text", 1, ["array"]]) {
      expect(refusal(() => validateMemoryMetadata(value)).message).toBe(
        "metadata must be an object",
      );
    }
    expect(refusal(() => validateMemoryMetadata({ big: BigInt(1) })).message).toBe(
      "metadata must be JSON serializable",
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(refusal(() => validateMemoryMetadata(circular, "filter")).field).toBe("filter");
    expect(refusal(() => validateMemoryMetadata({ nested: [{ "bad\u0000key": 1 }] })).message).toBe(
      "metadata contains a NUL character or invalid Unicode",
    );

    // `{"a":"…"}` is 8 characters of JSON around the string.
    const fits = { a: "m".repeat(MEMORY_METADATA_LIMITS.maximumSerializedLength - 8) };
    expect(validateMemoryMetadata(fits)).toBe(fits);
    const over = { a: "m".repeat(MEMORY_METADATA_LIMITS.maximumSerializedLength - 7) };
    expect(refusal(() => validateMemoryMetadata(over)).message).toBe(
      `metadata exceeds ${MEMORY_METADATA_LIMITS.maximumSerializedLength} characters`,
    );
  });

  test("bounded numbers take the fallback only when omitted", () => {
    const bounds = { minimum: 0, maximum: 2, fallback: 0.5 };
    expect(boundedNumber(undefined, "threshold", bounds)).toBe(0.5);
    expect(boundedNumber(0, "threshold", bounds)).toBe(0);
    expect(boundedNumber(2, "threshold", bounds)).toBe(2);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 2.01]) {
      expect(refusal(() => boundedNumber(value, "threshold", bounds)).message).toBe(
        "threshold must be a number from 0 through 2",
      );
    }
    expect(boundedInteger(undefined, "limit", { minimum: 1, maximum: 5, fallback: 3 })).toBe(3);
    expect(
      refusal(() => boundedInteger(2.5, "limit", { minimum: 1, maximum: 5, fallback: 3 })),
    ).toMatchObject({ field: "limit", message: "limit must be an integer from 1 through 5" });
  });

  test("a Link's kind, weight, and metadata are checked under its own field name", () => {
    const endpoints = { sourceMemoryId: "a", targetMemoryId: "b" };
    expect(validateMemoryLink({ ...endpoints, weight: 0 })).toEqual({
      kind: "related",
      weight: 0,
      metadata: {},
    });
    expect(validateMemoryLink({ ...endpoints, kind: "k".repeat(64), weight: 1 }).kind).toHaveLength(
      64,
    );
    expect(refusal(() => validateMemoryLink({ ...endpoints, kind: 7 }, "links[3]")).field).toBe(
      "links[3].kind",
    );
    expect(refusal(() => validateMemoryLink({ ...endpoints, weight: "0.5" })).field).toBe(
      "link.weight",
    );
    expect(refusal(() => validateMemoryLink({ ...endpoints, weight: -0.01 })).field).toBe(
      "link.weight",
    );
    expect(refusal(() => validateMemoryLink({ ...endpoints, metadata: [] })).field).toBe(
      "link.metadata",
    );
    // PostgreSQL stores the weight as real, which refuses a value that rounds to zero.
    expect(refusal(() => validateMemoryLink({ ...endpoints, weight: 1e-50 }))).toMatchObject({
      field: "link.weight",
      message: `link.weight must be 0 or at least ${2 ** -149}`,
    });
    expect(validateMemoryLink({ ...endpoints, weight: 2 ** -149 }).weight).toBe(2 ** -149);
    // Endpoint ids that differ only in case name the same Memory.
    const id = "40000000-0000-4000-8000-00000000000a";
    expect(
      refusal(() => validateMemoryLink({ sourceMemoryId: id, targetMemoryId: id.toUpperCase() })),
    ).toMatchObject({ field: "link", message: "link must connect two different Memories" });
  });
});

describe("Episode admission and reads", () => {
  const observation = { kind: "message" as const, content: "Recorded evidence." };

  test("an Episode is refused before any storage for each admission rule", () => {
    const record = (input: Partial<RecordEpisode> & Record<string, unknown>) => () =>
      normalizedEpisode({ kind: "conversation", observations: [observation], ...input });

    expect(refusal(record({ scope: "team" as "shared" })).field).toBe("scope");
    expect(refusal(record({ observations: "many" as unknown as [] })).message).toBe(
      "observations must be an array",
    );
    for (const count of [0, MAX_EPISODE_OBSERVATIONS + 1]) {
      expect(
        refusal(record({ observations: Array.from({ length: count }, () => observation) })).message,
      ).toBe(`observations must contain 1 to ${MAX_EPISODE_OBSERVATIONS} items`);
    }
    expect(refusal(record({ observations: [{ ...observation, content: "  " }] })).field).toBe(
      "observations[0].content",
    );
    const badTimestamp = refusal(
      record({ observations: [observation, { ...observation, observedAt: "yesterday" }] }),
    );
    expect(badTimestamp.field).toBe("observations[1].observedAt");
    expect(badTimestamp.message).toBe("observations[1].observedAt must be an ISO 8601 timestamp");
    const eleven = Array.from({ length: 11 }, () => ({
      ...observation,
      content: "c".repeat(MAX_EPISODE_CONTENT_CHARACTERS / 10),
    }));
    expect(refusal(record({ observations: eleven })).message).toBe(
      `Episode content exceeds ${MAX_EPISODE_CONTENT_CHARACTERS} characters`,
    );
    expect(normalizedEpisode({ kind: "event", observations: [observation] })).toMatchObject({
      observations: [{ kind: "message", content: observation.content, metadata: {} }],
    });
  });

  test("Episode list and batch reads refuse their bounds without querying", async () => {
    const episodes = createObservationModule(untouchedStorage);
    for (const limit of [0, 101, 1.5]) {
      expect((await asyncRefusal(episodes.list({ limit }))).field).toBe("limit");
    }
    expect((await asyncRefusal(episodes.list({ kind: "diary" as "event" }))).field).toBe("kind");
    expect((await asyncRefusal(episodes.list({ scope: "team" as "shared" }))).field).toBe("scope");
    const ids = Array.from(
      { length: MAX_OBSERVATION_BATCH_READ + 1 },
      (_, index) => `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect((await asyncRefusal(episodes.retrieveObservations(ids))).field).toBe("ids");
    // Duplicates count once, so the full batch plus a repeat passes on to storage.
    await expect(
      episodes.retrieveObservations([...ids.slice(0, MAX_OBSERVATION_BATCH_READ), ids[0] ?? ""]),
    ).rejects.toThrow("the engine must refuse before any query");
    await expect(episodes.retrieveObservations([])).resolves.toEqual([]);
  });

  test("Episode evidence options and search inputs are refused by field before any query", async () => {
    // Deployment options are operator configuration: an out-of-range one is a
    // configuration failure naming the option, never a caller's input refusal.
    for (const [options, field] of [
      [{ evidenceNeighborChunks: 3 }, "evidenceNeighborChunks"],
      [{ evidenceTopObservations: 0 }, "evidenceTopObservations"],
      [{ queryPlannerMaxQueries: 1.5 }, "queryPlannerMaxQueries"],
      [{ rerankCandidateLimit: 201 }, "rerankCandidateLimit"],
      [{ rerankMinimumScore: 1.01 }, "rerankMinimumScore"],
      [{ rerankWeight: Number.NaN }, "rerankWeight"],
      [{ semanticDistanceThreshold: -0.1 }, "semanticDistanceThreshold"],
    ] as const) {
      let failure: unknown;
      try {
        createEpisodeEvidenceModule(untouchedStorage, options);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LoreConfigurationError);
      expect(failure).not.toBeInstanceOf(LoreValidationError);
      expect(failure).toMatchObject({ option: field });
    }
    const evidence = createEpisodeEvidenceModule(untouchedStorage);
    for (const limit of [0, 101, 2.5]) {
      expect((await asyncRefusal(evidence.search({ query: "trajectory", limit }))).field).toBe(
        "limit",
      );
    }
    expect(
      await asyncRefusal(evidence.search({ query: "trajectory", sourceKeys: ["a"] })),
    ).toMatchObject({ field: "sourceKeys", message: "sourceKeys require groupMetadataKey" });
    const keys = Array.from({ length: 1_001 }, (_, index) => `source-${index}`);
    expect(
      await asyncRefusal(
        evidence.search({ query: "trajectory", groupMetadataKey: "id", sourceKeys: keys }),
      ),
    ).toMatchObject({ field: "sourceKeys", message: "At most 1000 source keys may be searched" });
    // Repeated keys count once, and a blank query searches nothing, but only after its
    // other inputs pass, as Memory search does.
    await expect(
      evidence.search({
        query: "trajectory",
        groupMetadataKey: "id",
        sourceKeys: [...keys.slice(0, 1_000), "source-0"],
      }),
    ).rejects.toThrow("the engine must refuse before any query");
    expect((await asyncRefusal(evidence.search({ query: "   ", limit: 0 }))).field).toBe("limit");
    expect((await asyncRefusal(evidence.search({ query: 42 as unknown as string }))).field).toBe(
      "query",
    );
    await expect(evidence.search({ query: "   " })).resolves.toEqual([]);
  });
});

describe("the engine validates before it writes", () => {
  /** A transaction that records every statement it is asked to run. */
  function watchedTransaction() {
    const statements: string[] = [];
    const transaction: PostgresTransaction = {
      query: async <Row>(sql: string) => {
        statements.push(sql);
        return { rows: [] as Row[] };
      },
    };
    return { statements, transaction };
  }

  test("single writes refuse scope and metadata before any statement", async () => {
    const primitives = createMemoryMutationPrimitives();
    const { statements, transaction } = watchedTransaction();
    const scope = { partitionId: untouchedStorage.partitionId, ownerId: untouchedStorage.ownerId };

    expect(
      (
        await asyncRefusal(
          primitives.insertMemoryInTransaction(transaction, scope, {
            content: "A fact.",
            scope: "team" as "shared",
          }),
        )
      ).field,
    ).toBe("scope");
    expect(
      (
        await asyncRefusal(
          primitives.updateMemoryInTransaction(transaction, scope, "id", {
            metadata: [] as unknown as Record<string, unknown>,
          }),
        )
      ).field,
    ).toBe("metadata");
    expect(statements).toEqual([]);
  });

  test("an update's scope and a search's query obey the rules before any statement", async () => {
    const primitives = createMemoryMutationPrimitives();
    const { statements, transaction } = watchedTransaction();
    const scope = { partitionId: untouchedStorage.partitionId, ownerId: untouchedStorage.ownerId };
    expect(
      await asyncRefusal(
        primitives.updateMemoryInTransaction(transaction, scope, "id", {
          scope: "team" as "shared",
        }),
      ),
    ).toMatchObject({ field: "scope", message: "scope must be shared or private" });
    expect(statements).toEqual([]);

    const memories = createMemoryModule(untouchedStorage, { embeddingDimensions: 8 });
    expect(await asyncRefusal(memories.search({ query: 42 as unknown as string }))).toMatchObject({
      field: "query",
      message: "query must be a string",
    });
    // The bound applies to the trimmed query, so surrounding whitespace is free.
    await expect(memories.search({ query: `  ${"q".repeat(10_000)}  `, limit: 1 })).rejects.toThrow(
      "the engine must refuse before any query",
    );
    for (const limit of [0, 101, 1.5]) {
      expect((await asyncRefusal(memories.search({ query: "fact", limit }))).field).toBe("limit");
    }
  });

  test("a batch reuses prepared chunks only when the engine produced them for that text", () => {
    const prepared = prepareMemoryContent("Prepared harbor fact.");
    expect(memoryContentChunks("Prepared harbor fact.", prepared)).toBe(prepared.chunks);
    // A lookalike the engine did not produce, or one for other text, is chunked again.
    const forged = { content: "Prepared harbor fact.", chunks: ["forged"] };
    expect(memoryContentChunks("Prepared harbor fact.", forged)).toEqual(["Prepared harbor fact."]);
    expect(memoryContentChunks("Other text.", prepared)).toEqual(["Other text."]);
    expect(() => memoryContentChunks("  ", prepared)).toThrow(MemoryContentValidationError);
  });

  test("a batch with one invalid record writes none of them", async () => {
    const primitives = createMemoryMutationPrimitives();
    const { statements, transaction } = watchedTransaction();
    const scope = { partitionId: untouchedStorage.partitionId, ownerId: untouchedStorage.ownerId };
    const valid = { id: "40000000-0000-4000-8000-000000000001", scope: "shared" as const };

    await expect(
      primitives.insertMemoriesInTransaction(transaction, scope, [
        { ...valid, content: "Valid.", metadata: {} },
        { ...valid, id: "40000000-0000-4000-8000-000000000002", content: "  ", metadata: {} },
      ]),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof MemoryContentValidationError &&
        error.field === "records[1].content" &&
        error.message === "Memory content is required",
    );
    await expect(
      primitives.insertMemoriesInTransaction(transaction, scope, [
        { ...valid, content: "Valid.", metadata: { note: "bad\u0000" } },
      ]),
    ).rejects.toMatchObject({ field: "records[0].metadata" });
    await expect(
      primitives.insertMemoriesInTransaction(transaction, scope, [
        { ...valid, content: "Valid.", metadata: {} },
        { ...valid, scope: "team" as "shared", content: "Valid.", metadata: {} },
      ]),
    ).rejects.toMatchObject({ field: "records[1].scope" });
    expect(
      (
        await asyncRefusal(
          insertMemoryLinksInTransaction(transaction, scope.partitionId, [
            { sourceMemoryId: "a", targetMemoryId: "b" },
            { sourceMemoryId: "a", targetMemoryId: "c", weight: 2 },
          ]),
        )
      ).field,
    ).toBe("links[1].weight");
    expect(statements).toEqual([]);
  });

  test("list and search filters obey the rules of the values they match", async () => {
    const memories = createMemoryModule(untouchedStorage, { embeddingDimensions: 8 });
    expect((await asyncRefusal(memories.list({ scope: "team" as "shared" }))).field).toBe("scope");
    expect(
      (
        await asyncRefusal(
          memories.search({
            query: "fact",
            metadataFilter: { key: "\uD800" },
          }),
        )
      ).field,
    ).toBe("metadataFilter");
    // A blank query searches nothing, but only after its filters pass.
    await expect(memories.search({ query: "  " })).resolves.toEqual([]);
    expect(
      (await asyncRefusal(memories.search({ query: "  ", scope: "team" as "shared" }))).field,
    ).toBe("scope");
  });
});
