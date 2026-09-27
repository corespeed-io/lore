import { expect, test } from "vitest";
import type { EmbeddingProvider } from "./capabilities";
import type { MemoryStorageContext, PostgresDatabase, PostgresTransaction } from "./db";
import { createMemoryMaintenanceModule } from "./maintenance";
import { createMemoryModule, type MemoryScope } from "./memory";
import {
  CORE_SCHEMA_CONTRACT,
  type SchemaContractGroup,
  type SchemaContractGroupName,
  type TableContract,
} from "./schema-contract";

export { CORE_SCHEMA_CONTRACT, type SchemaContractGroupName } from "./schema-contract";

/**
 * Every item of the named schema-contract groups that a database lacks, read from
 * its catalog: a table or column, an insertable NOT NULL column without a default,
 * a generated column, an ON CONFLICT unique key, a cascading foreign key, a type,
 * a function signature, an enum label set, or an enum value the engine compares.
 * An empty result means the schema provides those groups. Names are unqualified, so
 * they resolve through search_path as the engine's own SQL does.
 */
export async function missingSchemaContract(
  transaction: PostgresTransaction,
  groups: readonly SchemaContractGroupName[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of groups) {
    const group: SchemaContractGroup = CORE_SCHEMA_CONTRACT[name];
    for (const [table, contract] of Object.entries(group.tables)) {
      missing.push(
        ...(await missingTableContract(transaction, table, contract)).map(
          (item) => `${name}: ${item}`,
        ),
      );
    }
    for (const type of group.types) {
      const result = await transaction.query<{ present: boolean }>(
        "SELECT to_regtype($1) IS NOT NULL AS present",
        [type],
      );
      if (!result.rows[0]?.present) missing.push(`${name}: type ${type}`);
    }
    for (const signature of group.functions) {
      const result = await transaction.query<{ present: boolean }>(
        "SELECT to_regprocedure($1) IS NOT NULL AS present",
        [signature],
      );
      if (!result.rows[0]?.present) missing.push(`${name}: function ${signature}`);
    }
    for (const [type, labels] of Object.entries(group.enums)) {
      const present = (await enumLabels(transaction, type)).sort();
      if (present.join(",") !== [...labels].sort().join(",")) {
        missing.push(`${name}: enum ${type} (${[...labels].join(", ")})`);
      }
    }
    for (const [column, values] of Object.entries(group.values)) {
      const [table, attribute] = column.split(".") as [string, string];
      const result = await transaction.query<{ type_name: string | null }>(
        `SELECT format_type(attribute.atttypid, NULL) AS type_name
         FROM pg_attribute attribute
         WHERE attribute.attrelid = to_regclass($1) AND attribute.attname = $2`,
        [table, attribute],
      );
      const typeName = result.rows[0]?.type_name;
      if (!typeName) continue;
      const labels = await enumLabels(transaction, typeName);
      if (labels.length > 0 && values.some((value) => !labels.includes(value))) {
        missing.push(`${name}: values ${column} (${[...values].join(", ")})`);
      }
    }
  }
  return missing;
}

async function enumLabels(transaction: PostgresTransaction, type: string): Promise<string[]> {
  const result = await transaction.query<{ label: string }>(
    "SELECT enumlabel AS label FROM pg_enum WHERE enumtypid = to_regtype($1)",
    [type],
  );
  return result.rows.map((row) => row.label);
}

async function missingTableContract(
  transaction: PostgresTransaction,
  table: string,
  contract: TableContract,
): Promise<string[]> {
  const attributes = await transaction.query<{
    column_name: string;
    not_null: boolean;
    has_value: boolean;
    generated: boolean;
  }>(
    `SELECT attribute.attname AS column_name, attribute.attnotnull AS not_null,
       (attribute.atthasdef OR attribute.attidentity <> '' OR attribute.attgenerated <> '')
         AS has_value,
       attribute.attgenerated <> '' AS generated
     FROM pg_attribute attribute
     WHERE attribute.attrelid = to_regclass($1)
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped`,
    [table],
  );
  if (attributes.rows.length === 0) return [`table ${table}`];
  const missing: string[] = [];
  const byName = new Map(attributes.rows.map((row) => [row.column_name, row]));
  for (const column of new Set([...contract.columns, ...(contract.inserts ?? [])])) {
    if (!byName.has(column)) missing.push(`column ${table}.${column}`);
  }
  if (contract.inserts) {
    const inserted = new Set(contract.inserts);
    for (const row of attributes.rows) {
      if (row.not_null && !row.has_value && !inserted.has(row.column_name)) {
        missing.push(`default for ${table}.${row.column_name}, which the engine does not insert`);
      }
    }
  }
  for (const column of contract.generated ?? []) {
    if (byName.has(column) && !byName.get(column)?.generated) {
      missing.push(`generated column ${table}.${column}`);
    }
  }
  if (contract.uniqueKeys?.length) {
    const indexes = await transaction.query<{ columns: string[] }>(
      `SELECT ARRAY(
         SELECT attribute.attname
         FROM unnest(index.indkey) AS key(attnum)
         JOIN pg_attribute attribute
           ON attribute.attrelid = index.indrelid AND attribute.attnum = key.attnum
       ) AS columns
       FROM pg_index index
       WHERE index.indrelid = to_regclass($1) AND index.indisunique AND index.indpred IS NULL`,
      [table],
    );
    const unique = indexes.rows.map((row) => [...row.columns].sort().join(","));
    for (const key of contract.uniqueKeys) {
      if (!unique.includes([...key].sort().join(","))) {
        missing.push(`unique key ${table} (${key.join(", ")})`);
      }
    }
  }
  for (const cascade of contract.cascades ?? []) {
    const result = await transaction.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint constraint_row
         JOIN pg_attribute attribute
           ON attribute.attrelid = constraint_row.conrelid
          AND attribute.attnum = ANY(constraint_row.conkey)
         WHERE constraint_row.contype = 'f'
           AND constraint_row.confdeltype = 'c'
           AND constraint_row.conrelid = to_regclass($1)
           AND constraint_row.confrelid = to_regclass($2)
           AND attribute.attname = $3
       ) AS present`,
      [table, cascade.parent, cascade.column],
    );
    if (!result.rows[0]?.present) {
      missing.push(`cascading foreign key ${table}.${cascade.column} -> ${cascade.parent}`);
    }
  }
  return missing;
}

/**
 * Host-pluggable schema contract kit. A host supplies storage contexts whose
 * transaction wrappers enforce its own authorization policy. The suite checks
 * partition isolation, private/shared visibility, owner-only writes, chunk
 * reconstruction, unscoped read denial, and leased embedding maintenance.
 * Identity tables, roles, policy functions, and transaction initialization are
 * host-owned; the engine does not install or authenticate them.
 */

/**
 * Wrap a test database (a PGlite instance fits structurally) with host-owned
 * transaction initialization.
 */
export function testDatabase(
  postgres: PostgresDatabase,
  initializeTransaction: (transaction: PostgresTransaction) => Promise<void>,
): PostgresDatabase {
  return {
    transaction: (use) =>
      postgres.transaction(async (transaction) => {
        await initializeTransaction(transaction);
        return use(transaction);
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
