import { expect, test } from "vitest";
import type { EmbeddingProvider } from "./capabilities";
import {
  type ManagedTransactionDriver,
  type MemoryStorageContext,
  managedTransactionDatabase,
  type PostgresDatabase,
  type PostgresStatement,
  type PostgresTransaction,
  statement,
} from "./db";
import { createEmbeddingMaintenance } from "./maintenance";
import { createMemoryModule, type MemoryScope, RETRIEVAL_ENTITY_ALIAS_POLICY } from "./memory";
import { cjkLexicalGrams, relaxedEnglishTerms } from "./retrieval/query";
import {
  CORE_SCHEMA_CONTRACT,
  type SchemaContractGroup,
  type SchemaContractGroupName,
  type TableContract,
} from "./schema-contract";

// The query side of the CJK channel, for hosts that verify their index terms cover it.
export { cjkLexicalGrams } from "./retrieval/query";
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
  transaction: Pick<PostgresTransaction, "query">,
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

async function enumLabels(
  transaction: Pick<PostgresTransaction, "query">,
  type: string,
): Promise<string[]> {
  const result = await transaction.query<{ label: string }>(
    "SELECT enumlabel AS label FROM pg_enum WHERE enumtypid = to_regtype($1)",
    [type],
  );
  return result.rows.map((row) => row.label);
}

async function missingTableContract(
  transaction: Pick<PostgresTransaction, "query">,
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
    // An ON CONFLICT target matches only a whole, non-partial unique index on plain
    // columns: an expression key or a predicate leaves the target unmatched.
    const indexes = await transaction.query<{ columns: string[] }>(
      `SELECT ARRAY(
         SELECT attribute.attname
         FROM generate_series(0, index.indnkeyatts - 1) AS position(key)
         JOIN pg_attribute attribute
           ON attribute.attrelid = index.indrelid
          AND attribute.attnum = index.indkey[position.key]
       ) AS columns
       FROM pg_index index
       WHERE index.indrelid = to_regclass($1)
         AND index.indisunique
         AND index.indpred IS NULL
         AND index.indexprs IS NULL`,
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

/** One lexical search, as the engine's search statement asks for it. */
export interface LexicalCandidateQuery {
  query: string;
  candidateLimit: number;
  scope?: MemoryScope | null;
  updatedAfter?: string | null;
  updatedBefore?: string | null;
  metadataFilter?: Record<string, unknown> | null;
  excludedMemoryIds?: readonly string[];
  /** Whether the entity alias channel runs (the module's `entityAliasRecall`). */
  entityAliasRecall?: boolean;
}

export interface LexicalCandidateRow {
  channel: string;
  chunk_id: string;
  memory_id: string;
  candidate_rank: number | string;
}

/** The arguments both statements bind, derived as the engine derives them. */
function lexicalCandidateArguments(partitionId: string, input: LexicalCandidateQuery) {
  return {
    query: input.query,
    partitionId,
    candidateLimit: input.candidateLimit,
    relaxedTerms: relaxedEnglishTerms(input.query),
    scope: input.scope ?? null,
    updatedAfter: input.updatedAfter ?? null,
    updatedBefore: input.updatedBefore ?? null,
    metadataFilter: input.metadataFilter ? JSON.stringify(input.metadataFilter) : null,
    excludedMemoryIds: [...(input.excludedMemoryIds ?? [])],
    aliasLimit: input.entityAliasRecall ? RETRIEVAL_ENTITY_ALIAS_POLICY.maximumQueryAliases : 0,
    cjkGrams: cjkLexicalGrams(input.query),
  };
}

/** The host's `lore.lexical_candidates`, called with the engine's arguments. */
export function lexicalCandidatesStatement(
  partitionId: string,
  input: LexicalCandidateQuery,
): PostgresStatement<LexicalCandidateRow> {
  const values = lexicalCandidateArguments(partitionId, input);
  return statement<LexicalCandidateRow>(
    `SELECT channel, chunk_id, memory_id, candidate_rank
     FROM lore.lexical_candidates(
       $1::uuid, $2::text, $3::text[], $4::text[], $5::integer, $6::memory_scope,
       $7::timestamptz, $8::timestamptz, $9::jsonb, $10::uuid[], $11::integer
     )
     ORDER BY channel, candidate_rank`,
    [
      values.partitionId,
      values.query,
      values.relaxedTerms,
      values.cjkGrams,
      values.aliasLimit,
      values.scope,
      values.updatedAfter,
      values.updatedBefore,
      values.metadataFilter,
      values.excludedMemoryIds,
      values.candidateLimit,
    ],
  );
}

/**
 * The lexical channels as the engine's search statement ran them on the tables
 * through schema revision 11, which is what `lore.lexical_candidates` must answer:
 * the same chunks, with the same ranks, in every channel, for the same caller. Run in
 * a host transaction, it applies the host's access policy the way that statement
 * did (for lore oss, RLS as lore_app), and the host's function must apply the same
 * policy itself. It reads every chunk the caller may see, so it is a specification,
 * never a request path.
 */
export function referenceLexicalCandidates(
  partitionId: string,
  input: LexicalCandidateQuery,
): PostgresStatement<LexicalCandidateRow> {
  const values = lexicalCandidateArguments(partitionId, input);
  const filter = `($5::memory_scope IS NULL OR memory.scope = $5::memory_scope)
         AND ($6::timestamptz IS NULL OR memory.updated_at >= $6::timestamptz)
         AND ($7::timestamptz IS NULL OR memory.updated_at < $7::timestamptz)
         AND ($8::jsonb IS NULL OR memory.metadata @> $8::jsonb)
         AND NOT (memory.id = ANY($9::uuid[]))`;
  return statement<LexicalCandidateRow>(
    `WITH simple_lexical AS (
       SELECT chunk.id AS chunk_id, memory.id AS memory_id,
         row_number() OVER (
           ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', $1), 32) DESC,
                    memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM memory_chunks chunk
       JOIN memories memory
         ON memory.id = chunk.memory_id AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2::uuid AND ${filter}
         AND chunk.search_vector @@ websearch_to_tsquery('simple', $1)
       ORDER BY ts_rank_cd(chunk.search_vector, websearch_to_tsquery('simple', $1), 32) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $3
     ),
     english_lexical AS (
       SELECT chunk.id AS chunk_id, memory.id AS memory_id,
         row_number() OVER (
           ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', $1), 32) DESC,
                    memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM memory_chunks chunk
       JOIN memories memory
         ON memory.id = chunk.memory_id AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2::uuid AND ${filter}
         AND chunk.search_vector_english @@ websearch_to_tsquery('english', $1)
       ORDER BY ts_rank_cd(chunk.search_vector_english, websearch_to_tsquery('english', $1), 32) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $3
     ),
     english_query_terms AS MATERIALIZED (
       SELECT plainto_tsquery('english', term) AS query,
         max(CASE
               WHEN term ~ '^[[:upper:]][[:lower:]]' THEN 4.0
               WHEN term ~ '[[:digit:]]' THEN 3.0
               WHEN char_length(term) >= 10 THEN 1.5
               ELSE 1.0
             END) AS weight
       FROM unnest($4::text[]) AS term
       WHERE numnode(plainto_tsquery('english', term)) > 0
       GROUP BY plainto_tsquery('english', term)
     ),
     relaxed_english_lexical AS (
       SELECT chunk.id AS chunk_id, memory.id AS memory_id,
         row_number() OVER (
           ORDER BY sum(ts_rank_cd(chunk.search_vector_english, term.query, 32) * term.weight) DESC,
                    memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM memory_chunks chunk
       JOIN memories memory
         ON memory.id = chunk.memory_id AND memory.workspace_id = chunk.workspace_id
       JOIN english_query_terms term ON chunk.search_vector_english @@ term.query
       WHERE chunk.workspace_id = $2::uuid AND ${filter}
       GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
       HAVING count(*) >= 2
       ORDER BY sum(ts_rank_cd(chunk.search_vector_english, term.query, 32) * term.weight) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $3
     ),
     query_entity_aliases AS MATERIALIZED (
       SELECT alias
       FROM unnest(lore.extract_entity_aliases($1)) WITH ORDINALITY AS extracted(alias, ordinal)
       ORDER BY ordinal
       LIMIT $10::integer
     ),
     entity_alias_lexical AS (
       SELECT chunk.id AS chunk_id, memory.id AS memory_id,
         row_number() OVER (
           ORDER BY count(*) DESC, max(char_length(query_alias.alias)) DESC,
                    memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM query_entity_aliases query_alias
       JOIN memory_chunks chunk ON chunk.entity_aliases @> ARRAY[query_alias.alias]::text[]
       JOIN memories memory
         ON memory.id = chunk.memory_id AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2::uuid AND ${filter}
       GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
       ORDER BY count(*) DESC, max(char_length(query_alias.alias)) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $3
     ),
     cjk_lexical AS (
       SELECT chunk.id AS chunk_id, memory.id AS memory_id,
         row_number() OVER (
           ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                    memory.updated_at DESC, chunk.ordinal DESC, chunk.id
         ) AS candidate_rank
       FROM unnest($11::text[]) AS gram(gram)
       JOIN memory_chunks chunk ON chunk.content LIKE ('%' || gram.gram || '%')
       JOIN memories memory
         ON memory.id = chunk.memory_id AND memory.workspace_id = chunk.workspace_id
       WHERE chunk.workspace_id = $2::uuid AND ${filter}
       GROUP BY chunk.id, memory.id, chunk.ordinal, memory.updated_at
       HAVING count(*) >= least(2, cardinality($11::text[]))
       ORDER BY sum(char_length(gram.gram)) DESC, count(*) DESC,
                memory.updated_at DESC, chunk.ordinal DESC, chunk.id
       LIMIT $3
     )
     SELECT 'simple' AS channel, chunk_id, memory_id, candidate_rank FROM simple_lexical
     UNION ALL SELECT 'english', chunk_id, memory_id, candidate_rank FROM english_lexical
     UNION ALL SELECT 'relaxed_english', chunk_id, memory_id, candidate_rank FROM relaxed_english_lexical
     UNION ALL SELECT 'entity_alias', chunk_id, memory_id, candidate_rank FROM entity_alias_lexical
     UNION ALL SELECT 'cjk', chunk_id, memory_id, candidate_rank FROM cjk_lexical
     ORDER BY channel, candidate_rank`,
    [
      values.query,
      values.partitionId,
      values.candidateLimit,
      values.relaxedTerms,
      values.scope,
      values.updatedAfter,
      values.updatedBefore,
      values.metadataFilter,
      values.excludedMemoryIds,
      values.aliasLimit,
      values.cjkGrams,
    ],
  );
}

/** Candidates as comparable lines: `channel rank chunk memory`, in channel and rank order. */
function candidateLines(rows: readonly LexicalCandidateRow[]): string[] {
  return rows.map(
    (row) => `${row.channel} ${Number(row.candidate_rank)} ${row.chunk_id} ${row.memory_id}`,
  );
}

/**
 * Run each query through the host's `lore.lexical_candidates` and through the
 * reference channels, in one transaction of `storage`, and return both answers. A
 * host passes when every pair is equal; the reference's answers should also be
 * non-empty often enough to mean something.
 */
export async function compareLexicalCandidates(
  storage: MemoryStorageContext,
  queries: readonly LexicalCandidateQuery[],
): Promise<{ query: LexicalCandidateQuery; host: string[]; reference: string[] }[]> {
  return storage.database.transaction(async (transaction) => {
    const results = await transaction.batch(
      queries.flatMap((query) => [
        lexicalCandidatesStatement(storage.partitionId, query),
        referenceLexicalCandidates(storage.partitionId, query),
      ]),
    );
    return queries.map((query, index) => ({
      query,
      host: candidateLines(results[2 * index]?.rows ?? []),
      reference: candidateLines(results[2 * index + 1]?.rows ?? []),
    }));
  });
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
  postgres: ManagedTransactionDriver,
  initializeTransaction: (transaction: PostgresTransaction) => void | Promise<void>,
  observe?: (sql: string) => void,
): PostgresDatabase {
  return managedTransactionDatabase(postgres, {
    initialize: initializeTransaction,
    ...(observe ? { observe } : {}),
  });
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

  test("contract: lore.lexical_candidates answers the reference lexical channels", async () => {
    const fixture = await createFixture();
    try {
      const writers = {
        alice: createMemoryModule(fixture.alice, moduleOptions),
        bob: createMemoryModule(fixture.bob, moduleOptions),
        carol: createMemoryModule(fixture.carol, moduleOptions),
      };
      const long = (lead: string) =>
        `${lead}\n\n${"Background on the rollout and its retry budget. ".repeat(40)}\n\nKestrel owns the follow-up.`;
      const seeds: [keyof typeof writers, string, MemoryScope, Record<string, unknown>?][] = [
        [
          "alice",
          "Staging deploys run from the prod branch, not main.",
          "shared",
          { kind: "decision" },
        ],
        ["alice", "The staging deploy retry budget is two attempts.", "private"],
        ["alice", "Project Kestrel ships the Hyperdrive pooling change on Friday.", "shared"],
        [
          "alice",
          "Kestrel and Omega share one retry budget for staging deploys.",
          "shared",
          { kind: "decision" },
        ],
        ["alice", long("Deploy checklist for staging and prod."), "shared"],
        ["alice", "生产环境的记忆召回质量在八月的专项审计中被评为需要重点改进。", "shared"],
        ["alice", "记忆召回质量审计的结论由杭州团队提交给财务系统。", "private"],
        ["alice", "ユーザーデータベースの週次バックアップは日曜深夜に実行されます。", "shared"],
        ["bob", "Bob's private note: the staging retry budget is secretly three.", "private"],
        ["bob", "Bob shares that Kestrel deploys go through the Omega queue.", "shared"],
        ["bob", "鲍勃的私人记录：记忆召回质量审计的真实结论是完全达标。", "private"],
        ["bob", "서버 재시작 절차는 운영 위키에 있습니다.", "shared"],
        [
          "carol",
          "Another partition stages deploys with the same retry budget as Kestrel.",
          "shared",
        ],
        ["carol", "另一个分区的记忆召回质量审计结论。", "shared"],
      ];
      const ids: string[] = [];
      for (const [writer, content, scope, metadata] of seeds) {
        const memory = await writers[writer].remember({
          content,
          scope,
          ...(metadata ? { metadata } : {}),
        });
        ids.push(memory.id);
      }
      const queries = [
        "staging deploy",
        "Staging deploys run from the prod branch",
        "what is the retry budget for staging deploys",
        "Kestrel Omega retry",
        "Project Kestrel Hyperdrive",
        '"retry budget" -prod',
        "记忆召回质量的审计结论是什么？",
        "召回质量",
        "データベースのバックアップ",
        "서버 재시작",
        "nothing matches this at all",
      ];
      const filtered = (query: string): LexicalCandidateQuery[] => [
        { query, candidateLimit: 40, entityAliasRecall: true },
        { query, candidateLimit: 2, entityAliasRecall: true },
        { query, candidateLimit: 40 },
        { query, candidateLimit: 40, entityAliasRecall: true, scope: "private" },
        {
          query,
          candidateLimit: 40,
          entityAliasRecall: true,
          metadataFilter: { kind: "decision" },
        },
        { query, candidateLimit: 40, entityAliasRecall: true, excludedMemoryIds: ids.slice(0, 3) },
        {
          query,
          candidateLimit: 40,
          entityAliasRecall: true,
          updatedBefore: "2000-01-01T00:00:00Z",
        },
      ];
      let found = 0;
      for (const storage of [fixture.alice, fixture.bob, fixture.carol]) {
        const compared = await compareLexicalCandidates(storage, queries.flatMap(filtered));
        for (const { query, host, reference } of compared) {
          expect(host, JSON.stringify(query)).toEqual(reference);
          found += reference.length;
        }
      }
      // The comparison means something only when the channels find things.
      expect(found).toBeGreaterThan(100);
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
      const maintenance = createEmbeddingMaintenance(fixture.maintenanceDatabase, {
        embeddingProviders: [provider],
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
