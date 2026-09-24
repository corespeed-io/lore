import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  NON_TENANT_PUBLIC_TABLES as OPERATIONS_NON_TENANT_PUBLIC_TABLES,
  REQUIRED_TENANT_TABLES as OPERATIONS_REQUIRED_TENANT_TABLES,
} from "@/modules/operations/service";
import { applyMigrationChain } from "../../scripts/database/lib/migration-preflight.ts";
import {
  NON_TENANT_PUBLIC_TABLES,
  REQUIRED_TENANT_TABLES,
  verifyRestoredDatabase,
} from "../../scripts/database/restore.ts";

const postgres = new PGlite({ extensions: { pg_trgm, vector } });
const verify = () => verifyRestoredDatabase((sql) => postgres.query(sql));

beforeAll(async () => {
  await postgres.waitReady;
  await applyMigrationChain((sql) => postgres.exec(sql));
});

afterAll(() => postgres.close());

test("restore verification accepts the real leased-job grants without direct queue access", async () => {
  await expect(
    postgres.query(`
      SELECT has_table_privilege('lore_maintenance', 'public.memory_embedding_jobs', 'SELECT')
        AS direct_queue_read
    `),
  ).resolves.toMatchObject({ rows: [{ direct_queue_read: false }] });
  await expect(verify()).resolves.toMatchObject({ runtime_roles_safe: true, tenant_rls: true });
});

test("restore verification requires RLS on every tenant table, including tables added later", async () => {
  const protectedTables = await postgres.query<{ relname: string }>(
    `SELECT relname
     FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relrowsecurity
     ORDER BY relname`,
  );
  const names = protectedTables.rows.map((table) => table.relname);
  // The hand-kept list this replaced covered 21 tables and missed the rest.
  expect(names).toEqual(
    expect.arrayContaining([
      "code_index_jobs",
      "episode_evidence_chunk_embeddings",
      "memory_code_evidence",
      "memory_proposals",
    ]),
  );
  for (const table of names) {
    await postgres.exec("BEGIN");
    try {
      await postgres.exec(`ALTER TABLE public.${table} DISABLE ROW LEVEL SECURITY`);
      await expect(verify(), table).rejects.toThrow("Restored database failed Lore");
    } finally {
      await postgres.exec("ROLLBACK");
    }
  }
  await postgres.exec("BEGIN");
  try {
    await postgres.exec("CREATE TABLE public.future_tenant_records (id uuid PRIMARY KEY)");
    await expect(verify()).rejects.toThrow("Restored database failed Lore");
  } finally {
    await postgres.exec("ROLLBACK");
  }
  await expect(verify()).resolves.toMatchObject({ tenant_rls: true });
});

test("restore verification exempts an extension's own table, but never a tenant table", async () => {
  await postgres.exec("BEGIN");
  try {
    await postgres.exec("CREATE TABLE public.extension_reference_records (id integer)");
    await expect(verify()).rejects.toThrow("Restored database failed Lore");
    // As PostGIS owns spatial_ref_sys: the table belongs to the extension, not to Lore.
    await postgres.exec("ALTER EXTENSION vector ADD TABLE public.extension_reference_records");
    await expect(verify()).resolves.toMatchObject({ tenant_rls: true });
    // Extension ownership cannot excuse a tenant table from RLS.
    await postgres.exec("ALTER EXTENSION vector ADD TABLE public.memories");
    await postgres.exec("ALTER TABLE public.memories DISABLE ROW LEVEL SECURITY");
    await expect(verify()).rejects.toThrow("Restored database failed Lore");
  } finally {
    await postgres.exec("ROLLBACK");
  }
});

test("restore verification requires every tenant table to exist", async () => {
  const protectedTables = await postgres.query<{ relname: string }>(
    `SELECT relname
     FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relrowsecurity
     ORDER BY relname`,
  );
  const names = protectedTables.rows.map((table) => table.relname);
  // Both hand-kept lists must name exactly the schema's tenant tables, so a new
  // migration table cannot slip past readiness or restore verification.
  expect([...REQUIRED_TENANT_TABLES].sort()).toEqual(names);
  expect([...OPERATIONS_REQUIRED_TENANT_TABLES].sort()).toEqual(names);
  // Readiness and restore must agree on which public tables may lack RLS.
  expect([...NON_TENANT_PUBLIC_TABLES].sort()).toEqual(
    [...OPERATIONS_NON_TENANT_PUBLIC_TABLES].sort(),
  );

  for (const table of ["memory_links", "episode_evidence_chunks"]) {
    await postgres.exec("BEGIN");
    try {
      // A renamed table keeps RLS, so only the existence check can catch it.
      await postgres.exec(`ALTER TABLE public.${table} RENAME TO ${table}_missing`);
      await expect(verify(), table).rejects.toThrow("Restored database failed Lore");
    } finally {
      await postgres.exec("ROLLBACK");
    }
  }
  await expect(verify()).resolves.toMatchObject({ tenant_rls: true });
});

test.each([
  ["queue discovery", "lore.list_pending_memory_embedding_jobs(text,text,text,integer,integer)"],
  ["job claiming", "lore.claim_memory_embedding_job(uuid,text,text,text,uuid,integer)"],
  ["job completion", "lore.finish_memory_embedding_job(uuid,uuid,text,integer)"],
  ["job discovery", "lore.enqueue_stale_memory_embedding_jobs(text,text,text,integer)"],
])("restore verification rejects missing %s authorization", async (_name, signature) => {
  await postgres.exec("BEGIN");
  try {
    await postgres.exec(`REVOKE EXECUTE ON FUNCTION ${signature} FROM lore_maintenance`);
    await expect(verify()).rejects.toThrow("Restored database failed Lore");
  } finally {
    await postgres.exec("ROLLBACK");
  }
});

test.each([
  [
    "an absent queue function",
    "DROP FUNCTION lore.list_pending_memory_embedding_jobs(text,text,text,integer,integer)",
  ],
  ["missing schema access", "REVOKE USAGE ON SCHEMA lore FROM lore_maintenance"],
  ["direct queue access", "GRANT SELECT ON memory_embedding_jobs TO lore_maintenance"],
  ["missing RLS", "ALTER TABLE memories DISABLE ROW LEVEL SECURITY"],
  ["unsafe role attributes", "ALTER ROLE lore_maintenance BYPASSRLS"],
  ["unsafe role membership", "GRANT lore_maintenance TO lore_app"],
  ["missing request access", "REVOKE SELECT ON memories FROM lore_app"],
  [
    "an unsupported schema revision",
    "UPDATE lore_system_state SET schema_revision = 2147483647 WHERE singleton",
  ],
])("restore verification rejects %s", async (_name, mutation) => {
  await postgres.exec("BEGIN");
  try {
    await postgres.exec(mutation);
    await expect(verify()).rejects.toThrow("Restored database failed Lore");
  } finally {
    await postgres.exec("ROLLBACK");
  }
});
