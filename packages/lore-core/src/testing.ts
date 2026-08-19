import { expect, test } from "vitest";
import { type ActorContext, installActorContext } from "./actor-context";
import type { PostgresDatabase } from "./db";
import { createMemoryMaintenanceModule } from "./maintenance";
import { createMemoryModule, type EmbeddingProvider, type MemoryScope } from "./memory";

/**
 * Host-pluggable schema contract kit. A host points the suite at a database
 * migrated by ITS OWN chain (lore oss's db/migrations, HaaS's
 * packages/memory-core/migrations, …) and the suite asserts the engine's
 * behavioral invariants hold there: tenant isolation, private/shared
 * visibility, owner-only writes, exact chunk reconstruction, fail-closed
 * actor GUCs, and the leased embedding lane. Structural details (column
 * types, policy bodies, identity tables) are deliberately not asserted —
 * they are host-owned.
 */

/** Minimal structural view of a PGlite instance (or compatible driver). */
export interface TransactionalTestDatabase {
  transaction<T>(use: (transaction: TestDatabaseTransaction) => Promise<T>): Promise<T>;
}

export interface TestDatabaseTransaction {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/**
 * Wrap a transactional test database (PGlite in practice) as the engine's
 * PostgresDatabase seam, entering every transaction as the given NOLOGIN
 * runtime role exactly like production `SET LOCAL ROLE` does.
 */
export function testDatabaseForRole(
  postgres: TransactionalTestDatabase,
  role: "lore_app" | "lore_maintenance" | "NONE",
): PostgresDatabase {
  if (role !== "lore_app" && role !== "lore_maintenance" && role !== "NONE") {
    throw new Error("Unsupported test database role");
  }
  return {
    transaction: (use) =>
      postgres.transaction(async (transaction) => {
        await transaction.query(`SET LOCAL ROLE ${role}`);
        return use({
          query: (sql, params) => transaction.query(sql, params),
        });
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
  /** Request-path database entering transactions as lore_app. */
  database: PostgresDatabase;
  /** Maintenance database entering transactions as lore_maintenance. */
  maintenanceDatabase: PostgresDatabase;
  /** Two write-authorized actors sharing one workspace. */
  alice: ActorContext;
  bob: ActorContext;
  /** A write-authorized actor in a different workspace. */
  carol: ActorContext;
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

  test("contract: tenant isolation holds across workspaces", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.database, moduleOptions);
      const secret = await memories.remember(fixture.alice, {
        content: "The operations workspace launch code is aurora-42.",
        scope: "shared",
      });
      await expect(memories.retrieve(fixture.carol, secret.id)).resolves.toBeNull();
      await expect(memories.list(fixture.carol)).resolves.toEqual([]);
      const found = await memories.search(fixture.carol, { query: "aurora-42" });
      expect(found).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("contract: private Memory is owner-only; shared is workspace-visible", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.database, moduleOptions);
      const privateMemory = await memories.remember(fixture.alice, {
        content: "Alice's private planning note about the hidden venue.",
        scope: "private",
      });
      const sharedMemory = await memories.remember(fixture.alice, {
        content: "The team offsite is confirmed for the harbor office.",
        scope: "shared",
      });
      await expect(memories.retrieve(fixture.bob, privateMemory.id)).resolves.toBeNull();
      await expect(memories.retrieve(fixture.bob, sharedMemory.id)).resolves.toMatchObject({
        id: sharedMemory.id,
      });
      const bobSearch = await memories.search(fixture.bob, { query: "hidden venue" });
      expect(bobSearch).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("contract: sharing a Memory does not grant co-members write authority", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.database, moduleOptions);
      const shared = await memories.remember(fixture.alice, {
        content: "Shared decision: adopt the new deployment checklist.",
        scope: "shared",
      });
      await expect(
        memories.update(fixture.bob, shared.id, { content: "Tampered." }),
      ).resolves.toBeNull();
      await expect(memories.forget(fixture.bob, shared.id)).resolves.toBe(false);
      await expect(memories.retrieve(fixture.alice, shared.id)).resolves.toMatchObject({
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
      const memories = createMemoryModule(fixture.database, moduleOptions);
      const memory = await memories.remember(fixture.alice, {
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
      const memories = createMemoryModule(fixture.database, moduleOptions);
      const paragraph = "Deterministic chunking must reconstruct content exactly. ";
      const content = `# Contract\n\n${paragraph.repeat(60)}\n\n- item one\n- item two\n\n${"结尾段落包含中日韩文字与 emoji 🧭。".repeat(20)}`;
      const memory = await memories.remember(fixture.alice, { content });
      const reconstructed = await fixture.database.transaction(async (transaction) => {
        await installActorContext(transaction, fixture.alice);
        const chunks = await transaction.query<{ content: string }>(
          `SELECT content FROM memory_chunks
             WHERE workspace_id = $1 AND memory_id = $2
             ORDER BY ordinal`,
          [fixture.alice.workspaceId, memory.id],
        );
        return chunks.rows.map((row) => row.content).join("");
      });
      expect(reconstructed).toBe(content);
    } finally {
      await fixture.close();
    }
  });

  test("contract: a transaction without actor context sees nothing", async () => {
    const fixture = await createFixture();
    try {
      const memories = createMemoryModule(fixture.database, moduleOptions);
      await memories.remember(fixture.alice, {
        content: "Visible only through an installed actor context.",
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
      const memories = createMemoryModule(fixture.database, {
        ...moduleOptions,
        embeddingProvider: provider,
      });
      const memory = await memories.remember(fixture.alice, {
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
      const embedded = await fixture.database.transaction(async (transaction) => {
        await installActorContext(transaction, fixture.alice);
        const rows = await transaction.query<{ count: string | number }>(
          `SELECT count(*) AS count FROM memory_chunk_embeddings
             WHERE workspace_id = $1 AND memory_id = $2`,
          [fixture.alice.workspaceId, memory.id],
        );
        return Number(rows.rows[0]?.count ?? 0);
      });
      expect(embedded).toBeGreaterThan(0);
      const found = await memories.search(fixture.alice, { query: "tidal navigation" });
      expect(found.map((result) => result.memory.id)).toContain(memory.id);
    } finally {
      await fixture.close();
    }
  });
}
