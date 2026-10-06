import { PGlite } from "@electric-sql/pglite";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import {
  applyDirectMigration,
  inspectMigrationHistory,
  LATEST_SCHEMA_REVISION,
  type MigrationFile,
  migrationFiles,
  prepareDbmateHistory,
} from "../../scripts/database/lib/migration-preflight.ts";
import { migrationQueries, statementSql } from "../../scripts/database/lib/migration-statements.ts";
import { installActorContext } from "../../src/server/auth/actor-context";
import { createMemoryTestContext } from "../support/memory-context";

// Revisions 10 and 11 (0010, transactional; 0011, transaction:false). 0010 adds the
// compatible_from column that both migrations' final UPDATE writes, so it runs first.

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const SOURCE_ID = "30000000-0000-4000-8000-000000000001";
const TARGET_ID = "30000000-0000-4000-8000-000000000002";
const CHUNK_ID = "40000000-0000-4000-8000-000000000001";
const GENERATION_ID = "50000000-0000-4000-8000-000000000001";
const LINK_ID = "60000000-0000-4000-8000-000000000001";

const DROPPED_CHUNK_COLUMNS = [
  "embedded_at",
  "embedding",
  "embedding_model",
  "embedding_provider",
  "embedding_revision",
];

async function database() {
  const postgres = await PGlite.create({ extensions: { btree_gin, pg_trgm, vector } });
  onTestFinished(() => postgres.close());
  return postgres;
}

async function applyMigrations(postgres: PGlite, include: (number: number) => boolean) {
  for (const migration of await migrationFiles()) {
    if (!include(Number.parseInt(migration.id, 10))) continue;
    for (const query of migrationQueries(migration.sql, migration.id)) await postgres.exec(query);
  }
}

async function migration(version: string): Promise<MigrationFile> {
  const file = (await migrationFiles()).find((candidate) => candidate.version === version);
  if (!file) throw new Error(`migration ${version} is missing`);
  return file;
}

async function rows<T>(postgres: PGlite, sql: string, params: unknown[] = []) {
  return (await postgres.query<T>(sql, params)).rows;
}

async function chunkColumns(postgres: PGlite) {
  return (
    await rows<{ column_name: string }>(
      postgres,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'memory_chunks'
       ORDER BY column_name`,
    )
  ).map((row) => row.column_name);
}

async function indexes(postgres: PGlite, names: string[]) {
  return rows<{ name: string; valid: boolean; definition: string }>(
    postgres,
    `SELECT class.relname AS name, index.indisvalid AS valid,
            pg_get_indexdef(index.indexrelid) AS definition
     FROM pg_index index
     JOIN pg_class class ON class.oid = index.indexrelid
     WHERE class.relnamespace = 'public'::regnamespace AND class.relname = ANY($1::text[])
     ORDER BY class.relname`,
    [names],
  );
}

test("a revision-9 database with data upgrades through 0010 and 0011", async () => {
  const postgres = await database();
  await applyMigrations(postgres, (number) => number <= 9);
  await postgres.exec(`
    INSERT INTO users (id, display_name) VALUES ('${USER_ID}', 'Alice');
    INSERT INTO workspaces (id, name) VALUES ('${WORKSPACE_ID}', 'Upgrade');
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'owner');
    INSERT INTO memories (id, workspace_id, owner_user_id, content, metadata) VALUES
      ('${SOURCE_ID}', '${WORKSPACE_ID}', '${USER_ID}', 'Source', '{"team": "core"}'),
      ('${TARGET_ID}', '${WORKSPACE_ID}', '${USER_ID}', 'Target', '{}');
    INSERT INTO embedding_generations (
      id, embedding_provider, embedding_model, embedding_dimensions, embedding_revision,
      status, activated_at
    ) VALUES ('${GENERATION_ID}', 'fixture', 'fixture-v1', 1024, 'v1', 'active', now());
    -- A chunk that still carries a legacy baseline vector in the dropped columns.
    INSERT INTO memory_chunks (
      id, workspace_id, memory_id, ordinal, content,
      embedding, embedding_provider, embedding_model, embedding_revision, embedded_at
    ) VALUES (
      '${CHUNK_ID}', '${WORKSPACE_ID}', '${SOURCE_ID}', 0, 'Source',
      array_fill(0.5, ARRAY[1024])::vector, 'legacy', 'legacy-v0', 'v0', now()
    );
    INSERT INTO memory_chunk_embeddings (generation_id, workspace_id, memory_id, chunk_id, embedding)
    VALUES ('${GENERATION_ID}', '${WORKSPACE_ID}', '${SOURCE_ID}', '${CHUNK_ID}',
            array_fill(0.25, ARRAY[1024])::vector);
    INSERT INTO memory_links (id, workspace_id, source_memory_id, target_memory_id, kind)
    VALUES ('${LINK_ID}', '${WORKSPACE_ID}', '${SOURCE_ID}', '${TARGET_ID}', 'related');
  `);
  expect(await chunkColumns(postgres)).toEqual(expect.arrayContaining(DROPPED_CHUNK_COLUMNS));

  await applyMigrations(postgres, (number) => number > 9);

  for (const column of DROPPED_CHUNK_COLUMNS) {
    expect(await chunkColumns(postgres)).not.toContain(column);
  }
  await expect(
    rows(postgres, "SELECT id, memory_id, ordinal, content FROM memory_chunks"),
  ).resolves.toEqual([{ id: CHUNK_ID, memory_id: SOURCE_ID, ordinal: 0, content: "Source" }]);
  await expect(
    rows(
      postgres,
      "SELECT chunk_id, vector_dims(embedding) AS dimensions FROM memory_chunk_embeddings",
    ),
  ).resolves.toEqual([{ chunk_id: CHUNK_ID, dimensions: 1024 }]);
  await expect(
    rows(postgres, 'SELECT id FROM memories WHERE metadata @> \'{"team": "core"}\''),
  ).resolves.toEqual([{ id: SOURCE_ID }]);
  await expect(
    rows(postgres, "SELECT id, source_memory_id, target_memory_id FROM memory_links"),
  ).resolves.toEqual([{ id: LINK_ID, source_memory_id: SOURCE_ID, target_memory_id: TARGET_ID }]);
  await expect(
    rows(
      postgres,
      `SELECT schema_revision, compatible_from,
              lore.portable_core_capabilities()->'schemaRevision' AS published_revision,
              lore.portable_core_capabilities()->'compatibleFrom' AS published_compatible_from
       FROM lore_system_state WHERE singleton`,
    ),
  ).resolves.toEqual([
    {
      schema_revision: LATEST_SCHEMA_REVISION,
      compatible_from: 9,
      published_revision: LATEST_SCHEMA_REVISION,
      published_compatible_from: 9,
    },
  ]);
}, 60_000);

test("the migrated schema drops the unused chunk columns, indexes, and request UPDATE path", async () => {
  const postgres = await database();
  await applyMigrations(postgres, () => true);

  for (const column of DROPPED_CHUNK_COLUMNS) {
    expect(await chunkColumns(postgres)).not.toContain(column);
  }
  await expect(
    indexes(postgres, [
      "memories_metadata_gin_idx",
      "memory_chunk_embeddings_chunk_idx",
      "memory_chunks_embedding_cosine_idx",
      "memory_links_workspace_source_idx",
    ]),
  ).resolves.toEqual([
    {
      name: "memory_chunk_embeddings_chunk_idx",
      valid: true,
      definition:
        "CREATE INDEX memory_chunk_embeddings_chunk_idx ON public.memory_chunk_embeddings USING btree (chunk_id)",
    },
  ]);
  await expect(
    rows(
      postgres,
      `SELECT conname FROM pg_constraint
       WHERE conname IN ('memory_chunks_embedding_state_check', 'lore_system_state_compatible_from_check')`,
    ),
  ).resolves.toEqual([{ conname: "lore_system_state_compatible_from_check" }]);
  await expect(
    rows(
      postgres,
      "SELECT policyname FROM pg_policies WHERE tablename = 'memory_chunks' ORDER BY policyname",
    ),
  ).resolves.toEqual([
    { policyname: "memory_chunks_delete" },
    { policyname: "memory_chunks_insert" },
    { policyname: "memory_chunks_maintenance_select" },
    { policyname: "memory_chunks_select" },
  ]);
  await expect(
    rows(
      postgres,
      `SELECT
         has_table_privilege('lore_app', 'memory_chunks', 'UPDATE') AS app_update,
         has_table_privilege('lore_maintenance', 'memory_chunks', 'UPDATE') AS maintenance_update,
         has_table_privilege('lore_app', 'memory_chunks', 'SELECT')
           AND has_table_privilege('lore_app', 'memory_chunks', 'INSERT')
           AND has_table_privilege('lore_app', 'memory_chunks', 'DELETE') AS app_writes`,
    ),
  ).resolves.toEqual([{ app_update: false, maintenance_update: false, app_writes: true }]);
  // compatible_from may not exceed the revision it accompanies.
  await expect(
    postgres.exec("UPDATE lore_system_state SET compatible_from = schema_revision + 1"),
  ).rejects.toThrow("lore_system_state_compatible_from_check");
}, 60_000);

test("the request role can no longer update chunk rows", async () => {
  const testContext = await createMemoryTestContext();
  onTestFinished(() => testContext.close());
  await expect(
    testContext.database.transaction(async (transaction) => {
      await installActorContext(transaction, testContext.alice);
      await transaction.query("UPDATE memory_chunks SET content = content");
    }),
  ).rejects.toMatchObject({ code: "42501" });
});

test("no function in the lore schema is executable by PUBLIC", async () => {
  const postgres = await database();
  await applyMigrations(postgres, () => true);
  await expect(
    rows(
      postgres,
      `SELECT function.oid::regprocedure::text AS signature
       FROM pg_proc function
       WHERE function.pronamespace = 'lore'::regnamespace
         AND EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         )`,
    ),
  ).resolves.toEqual([]);
  // The guard has something to guard: lore holds the schema's functions.
  const [count] = await rows<{ functions: number }>(
    postgres,
    "SELECT count(*)::integer AS functions FROM pg_proc WHERE pronamespace = 'lore'::regnamespace",
  );
  expect(count?.functions).toBeGreaterThan(50);
}, 60_000);

// Every request reads memories as lore_app under RLS. jsonb @> is not leakproof, so
// the planner must evaluate the row policy before it and can never make it an index
// condition there; only a role that bypasses RLS could use the GIN index 0011 drops.
test("under RLS a metadata filter can never use a GIN index on memories.metadata", async () => {
  const testContext = await createMemoryTestContext();
  onTestFinished(() => testContext.close());
  const filter = 'SELECT id FROM memories WHERE metadata @> \'{"team": "core"}\'::jsonb';
  const plan = async (database: typeof testContext.database, asAlice: boolean) =>
    database.transaction(async (transaction) => {
      if (asAlice) await installActorContext(transaction, testContext.alice);
      await transaction.query("SET LOCAL enable_seqscan = off");
      const result = await transaction.query<{ "QUERY PLAN": string }>(`EXPLAIN ${filter}`);
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

  await testContext.adminDatabase.transaction(async (transaction) => {
    const [contains] = (
      await transaction.query<{ leakproof: boolean }>(
        "SELECT proleakproof AS leakproof FROM pg_proc WHERE oid = 'jsonb_contains(jsonb,jsonb)'::regprocedure",
      )
    ).rows;
    expect(contains).toEqual({ leakproof: false });
    await transaction.query(
      "CREATE INDEX memories_metadata_gin_idx ON memories USING gin (metadata jsonb_path_ops)",
    );
  });

  // The owner bypasses RLS and uses the index; the request role cannot.
  expect(await plan(testContext.adminDatabase, false)).toContain("memories_metadata_gin_idx");
  const requestPlan = await plan(testContext.database, true);
  expect(requestPlan).not.toContain("memories_metadata_gin_idx");
  expect(requestPlan).toMatch(/Filter: .*metadata @>/);
});

// 0010 alters memory_chunks and lore_system_state; replacing a plpgsql function takes
// no table lock. Request writes lock memories before memory_chunks, and 0010 never
// locks memories, so it cannot join a lock cycle with them.
test("0010 takes exclusive locks only on memory_chunks and lore_system_state", async () => {
  const postgres = await database();
  await applyMigrations(postgres, (number) => number < 10);
  const transactional = await migration("0010");

  await postgres.exec("BEGIN");
  for (const query of migrationQueries(transactional.sql, transactional.id)) {
    await postgres.exec(query);
  }
  const locked = await rows<{ relname: string; modes: string[] }>(
    postgres,
    `SELECT class.relname, array_agg(DISTINCT lock.mode ORDER BY lock.mode) AS modes
     FROM pg_locks lock
     JOIN pg_class class ON class.oid = lock.relation
     JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
     WHERE lock.pid = pg_backend_pid() AND namespace.nspname = 'public' AND class.relkind = 'r'
     GROUP BY class.relname
     ORDER BY class.relname`,
  );
  await postgres.exec("ROLLBACK");
  // Validating the SQL-language capabilities body reads embedding_generations and
  // lore_system_state, which takes ACCESS SHARE; nothing at run time takes ACCESS
  // EXCLUSIVE on embedding_generations, so that read cannot wait or be waited on.
  expect(locked).toEqual([
    { relname: "embedding_generations", modes: ["AccessShareLock"] },
    {
      relname: "lore_system_state",
      modes: ["AccessExclusiveLock", "AccessShareLock", "RowExclusiveLock"],
    },
    { relname: "memory_chunks", modes: ["AccessExclusiveLock", "AccessShareLock"] },
  ]);
}, 60_000);

// The chunk table is locked before lore_system_state, so readiness, which reads
// lore_system_state with a 2s statement timeout, is not blocked while 0010 waits
// (up to its 5s lock_timeout) for request writes to release memory_chunks.
test("0010 alters memory_chunks before it touches lore_system_state", async () => {
  const sql = statementSql((await migration("0010")).sql);
  const chunks = sql.indexOf("ALTER TABLE public.memory_chunks");
  const state = sql.indexOf("ALTER TABLE public.lore_system_state");
  expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
  expect(chunks).toBeGreaterThan(0);
  expect(state).toBeGreaterThan(chunks);
});

test("a stopped 0011 run records nothing, and the rerun finishes from any point", async () => {
  const postgres = await database();
  const migrations = await migrationFiles();
  const concurrent = await migration("0011");
  await prepareDbmateHistory(postgres, migrations);
  for (const file of migrations.filter((candidate) => candidate.version <= "0010")) {
    for (const query of migrationQueries(file.sql, file.id)) await postgres.exec(query);
    await postgres.query("INSERT INTO lore_schema_migrations (version, checksum) VALUES ($1, $2)", [
      file.version,
      file.checksum,
    ]);
  }

  // dbmate would send the file as one query, which PostgreSQL refuses.
  await expect(postgres.exec(concurrent.sql)).rejects.toThrow(
    "cannot run inside a transaction block",
  );

  // Stop after the build and the first drop, leaving the build INVALID as a cancelled
  // concurrent build does.
  const statements = migrationQueries(concurrent.sql, concurrent.id);
  for (const query of statements.slice(0, 3)) await postgres.exec(query);
  await postgres.exec(
    `UPDATE pg_index SET indisvalid = false
     WHERE indexrelid = 'public.memory_chunk_embeddings_chunk_idx'::regclass`,
  );
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    ok: true,
    revision: 10,
  });

  await applyDirectMigration(postgres, concurrent);

  await expect(
    indexes(postgres, [
      "memories_metadata_gin_idx",
      "memory_chunk_embeddings_chunk_idx",
      "memory_links_workspace_source_idx",
    ]),
  ).resolves.toEqual([
    expect.objectContaining({ name: "memory_chunk_embeddings_chunk_idx", valid: true }),
  ]);
  await expect(inspectMigrationHistory(postgres, migrations)).resolves.toMatchObject({
    kind: "dbmate",
    ok: true,
    revision: 11,
  });
  await expect(
    rows(postgres, "SELECT compatible_from FROM lore_system_state WHERE singleton"),
  ).resolves.toEqual([{ compatible_from: 9 }]);
}, 60_000);

// compatible_from defaults to nothing: a migration that forgot it would keep the
// previous value and claim compatibility it never checked.
test("every migration from 0010 on declares the oldest revision it stays compatible with", async () => {
  const declared = (await migrationFiles())
    .filter((file) => Number(file.version) >= 10)
    .map((file) => {
      const statements = migrationQueries(file.sql, file.id);
      const last = statementSql(statements.at(-1) ?? "");
      const match =
        /UPDATE public\.lore_system_state\s+SET schema_revision = (\d+), compatible_from = (\d+),/.exec(
          last.slice(last.lastIndexOf("UPDATE public.lore_system_state")),
        );
      return { version: Number(file.version), revision: match?.[1], compatibleFrom: match?.[2] };
    });
  expect(declared.length).toBeGreaterThanOrEqual(2);
  for (const { version, revision, compatibleFrom } of declared) {
    expect(Number(revision), `revision of ${version}`).toBe(version);
    expect(Number(compatibleFrom), `compatible_from of ${version}`).toBeGreaterThanOrEqual(1);
    expect(Number(compatibleFrom), `compatible_from of ${version}`).toBeLessThanOrEqual(version);
  }
});
