import { expect, test } from "vitest";
import type { EmbeddingProvider } from "./capabilities";
import type { MemoryStorageContext, PostgresDatabase, PostgresTransaction } from "./db";
import { createMemoryMaintenanceModule } from "./maintenance";
import { createMemoryModule, type MemoryScope } from "./memory";

/**
 * Host-pluggable schema contract kit. A host supplies storage contexts whose
 * transaction wrappers enforce its own authorization policy. The suite checks
 * partition isolation, private/shared visibility, owner-only writes, chunk
 * reconstruction, unscoped read denial, and leased embedding maintenance.
 * Identity tables, roles, policy functions, and transaction initialization are
 * host-owned; the engine does not install or authenticate them.
 */

/** Minimal structural view of a PGlite instance (or compatible driver). */
export interface TransactionalTestDatabase {
  transaction<T>(use: (transaction: TestDatabaseTransaction) => Promise<T>): Promise<T>;
}

export interface TestDatabaseTransaction {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/** Adapt a test database with optional host-owned transaction initialization. */
export function testDatabase(
  postgres: TransactionalTestDatabase,
  initializeTransaction?: (transaction: PostgresTransaction) => Promise<void>,
): PostgresDatabase {
  return {
    transaction: (use) =>
      postgres.transaction(async (transaction) => {
        await initializeTransaction?.(transaction);
        return use({ query: (sql, params) => transaction.query(sql, params) });
      }),
  };
}

/** Deterministic, dependency-free embedding provider for contract tests. */
export function createDeterministicTestEmbeddingProvider(
  dimensions: number,
  identity: { provider?: string; model?: string; revision?: string } = {},
): EmbeddingProvider {
  function vectorFor(text: string): number[] {
    const vector = new Array<number>(dimensions).fill(0);
    for (let index = 0; index < text.length; index += 1) {
      const slot = (text.codePointAt(index) ?? 0) % dimensions;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }
  return {
    provider: identity.provider ?? "test",
    model: identity.model ?? "deterministic-contract",
    dimensions,
    revision: identity.revision ?? "contract-v1",
    embed: (texts: string[]) => Promise.resolve(texts.map((text) => vectorFor(text))),
  };
}

export interface MemoryCoreContractFixture {
  /** Unscoped request database, with the host request role but no caller context. */
  database: PostgresDatabase;
  /** Database with the host-authorized maintenance policy. */
  maintenanceDatabase: PostgresDatabase;
  /** Two owner contexts in the same storage partition. */
  alice: MemoryStorageContext;
  bob: MemoryStorageContext;
  /** An owner context in a different storage partition. */
  carol: MemoryStorageContext;
  close(): Promise<void>;
}

export interface MemoryCoreContractOptions {
  /** The host schema's embedding-space width. Defaults to 1024. */
  embeddingDimensions?: number;
  /** The host's default Memory scope. Defaults to "shared". */
  defaultMemoryScope?: MemoryScope;
}

/**
 * Register the engine's schema contract tests against a host fixture.
 * Import and call from a vitest suite:
 *
 *   runMemoryCoreContractSuite(createMyHostFixture, { embeddingDimensions: 1536 });
 */
export function runMemoryCoreContractSuite(
  createFixture: () => Promise<MemoryCoreContractFixture>,
  options: MemoryCoreContractOptions = {},
): void {
  const dimensions = options.embeddingDimensions ?? 1024;
  const defaultScope = options.defaultMemoryScope ?? "shared";
  const moduleOptions = {
    embeddingDimensions: dimensions,
    ...(options.defaultMemoryScope ? { defaultMemoryScope: options.defaultMemoryScope } : {}),
  };

  test("contract: isolation holds across storage partitions", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.alice, moduleOptions);
      const secret = await memories.remember({
        content: "The operations workspace launch code is aurora-42.",
        scope: "shared",
      });
      await expect(
        createMemoryModule(fixture.carol, moduleOptions).retrieve(secret.id),
      ).resolves.toBeNull();
      await expect(createMemoryModule(fixture.carol, moduleOptions).list()).resolves.toEqual([]);
      const found = await createMemoryModule(fixture.carol, moduleOptions).search({
        query: "aurora-42",
      });
      expect(found).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("contract: private Memory is owner-only; shared is partition-visible", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.alice, moduleOptions);
      const privateMemory = await memories.remember({
        content: "Alice's private planning note about the hidden venue.",
        scope: "private",
      });
      const sharedMemory = await memories.remember({
        content: "The team offsite is confirmed for the harbor office.",
        scope: "shared",
      });
      await expect(
        createMemoryModule(fixture.bob, moduleOptions).retrieve(privateMemory.id),
      ).resolves.toBeNull();
      await expect(
        createMemoryModule(fixture.bob, moduleOptions).retrieve(sharedMemory.id),
      ).resolves.toMatchObject({
        id: sharedMemory.id,
      });
      const bobSearch = await createMemoryModule(fixture.bob, moduleOptions).search({
        query: "hidden venue",
      });
      expect(bobSearch).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("contract: sharing a Memory does not grant co-members write authority", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.alice, moduleOptions);
      const shared = await memories.remember({
        content: "Shared decision: adopt the new deployment checklist.",
        scope: "shared",
      });
      await expect(
        createMemoryModule(fixture.bob, moduleOptions).update(shared.id, { content: "Tampered." }),
      ).resolves.toBeNull();
      await expect(createMemoryModule(fixture.bob, moduleOptions).forget(shared.id)).resolves.toBe(
        false,
      );
      await expect(memories.retrieve(shared.id)).resolves.toMatchObject({
        content: "Shared decision: adopt the new deployment checklist.",
        version: 1,
      });
    } finally {
      await fixture.close();
    }
  });

  test("contract: new Memories default to the host's configured scope", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.alice, moduleOptions);
      const memory = await memories.remember({
        content: "A memory written without an explicit scope.",
      });
      expect(memory.scope).toBe(defaultScope);
    } finally {
      await fixture.close();
    }
  });

  test("contract: chunks reconstruct canonical content exactly", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.alice, moduleOptions);
      const paragraph = "Deterministic chunking must reconstruct content exactly. ";
      const content = `# Contract\n\n${paragraph.repeat(60)}\n\n- item one\n- item two\n\n${"结尾段落包含中日韩文字与 emoji 🧭。".repeat(20)}`;
      const memory = await memories.remember({ content });
      const reconstructed = await fixture.alice.database.transaction(async (transaction) => {
        const chunks = await transaction.query<{ content: string }>(
          `SELECT content FROM memory_chunks
             WHERE workspace_id = $1 AND memory_id = $2
             ORDER BY ordinal`,
          [fixture.alice.partitionId, memory.id],
        );
        return chunks.rows.map((row) => row.content).join("");
      });
      expect(reconstructed).toBe(content);
    } finally {
      await fixture.close();
    }
  });

  test("contract: an unscoped host transaction sees nothing", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.alice, moduleOptions);
      await memories.remember({
        content: "Visible only through an initialized host storage context.",
        scope: "shared",
      });
      const bare = await fixture.database.transaction(async (transaction) => {
        const rows = await transaction.query<{ id: string }>("SELECT id FROM memories");
        return rows.rows;
      });
      expect(bare).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("contract: the leased embedding lane embeds exactly the enqueued Memory", async () => {
    const fixture = await createFixture();
    try {
      const provider = createDeterministicTestEmbeddingProvider(dimensions);
      const memories = createMemoryModule(fixture.alice, {
        ...moduleOptions,
        embeddingProvider: provider,
      });
      const memory = await memories.remember({
        content: "Semantic contract memory about tidal navigation charts.",
        scope: "shared",
      });
      const maintenance = createMemoryMaintenanceModule(fixture.maintenanceDatabase, {
        embeddingProvider: provider,
      });
      let guard = 0;
      for (;;) {
        const result = await maintenance.run();
        if (result.status === "idle") break;
        if (result.status === "dead") throw new Error("Embedding job died in contract test");
        guard += 1;
        if (guard > 10) throw new Error("Embedding lane did not drain");
      }
      const embedded = await fixture.alice.database.transaction(async (transaction) => {
        const rows = await transaction.query<{ count: string | number }>(
          `SELECT count(*) AS count FROM memory_chunk_embeddings
             WHERE workspace_id = $1 AND memory_id = $2`,
          [fixture.alice.partitionId, memory.id],
        );
        return Number(rows.rows[0]?.count ?? 0);
      });
      expect(embedded).toBeGreaterThan(0);
      const found = await memories.search({ query: "tidal navigation" });
      expect(found.map((result) => result.memory.id)).toContain(memory.id);
    } finally {
      await fixture.close();
    }
  });
}
