import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { isSchemaRevisionSupported } from "./lib/migration-preflight.ts";

type RestoredDatabaseState = {
  schema_revision: number | null;
  tenant_rls: boolean | null;
  runtime_roles_safe: boolean | null;
  has_vector: boolean;
  app_can_select: boolean;
  maintenance_can_execute: boolean | null;
  maintenance_queue_restricted: boolean;
};

/**
 * Public tables without tenant data, the only ones allowed to lack RLS. Keep in
 * step with NON_TENANT_PUBLIC_TABLES in src/modules/operations/service.ts; every
 * other public table, including one added by a later migration, must enable RLS,
 * except a table an extension owns (PostGIS `spatial_ref_sys`, say).
 */
export const NON_TENANT_PUBLIC_TABLES = ["lore_schema_migrations", "lore_system_state"] as const;

/**
 * Tenant tables a restored database must contain, each with RLS enabled. Keep in
 * step with REQUIRED_TENANT_TABLES in src/modules/operations/service.ts; a test
 * pins both lists to the migrated schema's RLS tables.
 */
export const REQUIRED_TENANT_TABLES = [
  "agent_credentials",
  "agents",
  "agent_workspace_grants",
  "code_artifact_payloads",
  "code_artifacts",
  "code_dependency_edges",
  "code_dependency_payloads",
  "code_dependency_sets",
  "code_index_generations",
  "code_index_jobs",
  "code_repositories",
  "code_revision_files",
  "code_revisions",
  "code_symbol_payloads",
  "code_symbol_sets",
  "embedding_generations",
  "episode_evidence_chunk_embeddings",
  "episode_evidence_chunks",
  "episodes",
  "evaluation_cases",
  "evaluation_results",
  "evaluation_runs",
  "evaluation_suites",
  "identities",
  "memberships",
  "memories",
  "memory_chunk_embeddings",
  "memory_chunks",
  "memory_code_evidence",
  "memory_embedding_jobs",
  "memory_events",
  "memory_import_provenance",
  "memory_links",
  "memory_proposal_code_evidence",
  "memory_proposal_evidence",
  "memory_proposal_observation_evidence",
  "memory_proposals",
  "observations",
  "request_idempotency_records",
  "users",
  "workspace_imports",
  "workspaces",
] as const;

export async function verifyRestoredDatabase(
  query: (sql: string) => Promise<{ rows: RestoredDatabaseState[] }>,
): Promise<RestoredDatabaseState> {
  const nonTenantTables = NON_TENANT_PUBLIC_TABLES.map((name) => `'${name}'`).join(", ");
  const requiredTables = REQUIRED_TENANT_TABLES.map((name) => `('${name}')`).join(", ");
  const result = await query(
    `WITH required_tenant_tables(table_name) AS (
       VALUES ${requiredTables}
     ), required_tenant_state AS (
       -- Every tenant table must exist, so an empty, partial, or foreign database
       -- cannot pass.
       SELECT count(relation.oid) = count(*)
         AND coalesce(bool_and(relation.relrowsecurity), false) AS present
       FROM required_tenant_tables required
       LEFT JOIN pg_class relation
         ON relation.oid = to_regclass('public.' || required.table_name)
     ), rls_state AS (
       SELECT (SELECT present FROM required_tenant_state) AND NOT EXISTS (
         SELECT 1
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relkind IN ('r', 'p')
           AND NOT relation.relrowsecurity
           AND relation.relname NOT IN (${nonTenantTables})
           -- An extension's own table belongs to the extension, not to Lore.
           AND NOT EXISTS (
             SELECT 1
             FROM pg_depend dependency
             WHERE dependency.classid = 'pg_class'::regclass
               AND dependency.objid = relation.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
           )
       ) AS enabled
     ), required_maintenance_functions(signature) AS (
       VALUES
         ('lore.enqueue_stale_memory_embedding_jobs(text,text,text,integer)'),
         ('lore.list_pending_memory_embedding_jobs(text,text,text,integer,integer)'),
         ('lore.claim_memory_embedding_job(uuid,text,text,text,uuid,integer)'),
         ('lore.finish_memory_embedding_job(uuid,uuid,text,integer)')
     ), maintenance_state AS (
       SELECT count(function.oid) = count(*) AND bool_and(
         function.prosecdef AND has_function_privilege('lore_maintenance', function.oid, 'EXECUTE')
       ) AS can_execute
       FROM required_maintenance_functions required
       LEFT JOIN pg_proc function ON function.oid = to_regprocedure(required.signature)
     ), role_state AS (
       SELECT count(*) = 2 AND bool_and(
         NOT role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb
         AND NOT role.rolcreaterole AND NOT role.rolinherit AND NOT role.rolreplication
         AND NOT role.rolbypassrls AND NOT EXISTS (
           SELECT 1 FROM pg_auth_members membership
           WHERE membership.member = role.oid OR membership.roleid = role.oid
         )
       ) AS safe
       FROM pg_roles role
       WHERE role.rolname IN ('lore_app', 'lore_maintenance')
     )
     SELECT
       (SELECT schema_revision FROM lore_system_state WHERE singleton) AS schema_revision,
       (SELECT enabled FROM rls_state) AS tenant_rls,
       (SELECT safe FROM role_state) AS runtime_roles_safe,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
       has_table_privilege('lore_app', 'memories', 'SELECT') AS app_can_select,
       has_schema_privilege('lore_maintenance', 'lore', 'USAGE')
         AND (SELECT can_execute FROM maintenance_state) AS maintenance_can_execute,
       -- Queue access is restricted to the leased-job SECURITY DEFINER functions.
       NOT has_table_privilege('lore_maintenance', 'public.memory_embedding_jobs', 'SELECT')
         AS maintenance_queue_restricted`,
  );
  const row = result.rows[0];
  if (
    !row?.tenant_rls ||
    !row.runtime_roles_safe ||
    !row.has_vector ||
    !row.app_can_select ||
    !row.maintenance_can_execute ||
    !row.maintenance_queue_restricted ||
    !isSchemaRevisionSupported(Number(row.schema_revision))
  ) {
    throw new Error("Restored database failed Lore schema, RLS, or extension verification");
  }
  return row;
}

async function restoreDatabase(): Promise<void> {
  const databaseUrl = process.env.LORE_RESTORE_DATABASE_URL;
  const requestedPath = process.env.LORE_BACKUP_PATH;
  if (!databaseUrl) throw new Error("LORE_RESTORE_DATABASE_URL is required");
  if (!requestedPath) throw new Error("LORE_BACKUP_PATH is required");

  const target = new URL(databaseUrl);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!databaseName || process.env.LORE_RESTORE_CONFIRM !== databaseName) {
    throw new Error(`Set LORE_RESTORE_CONFIRM=${databaseName} to confirm the exact restore target`);
  }

  const backupPath = resolve(requestedPath);
  const manifest: unknown = JSON.parse(await readFile(`${backupPath}.manifest.json`, "utf8"));
  const hash = createHash("sha256");
  const backupStream: AsyncIterable<Uint8Array> = createReadStream(backupPath);
  for await (const chunk of backupStream) hash.update(chunk);
  const checksum = hash.digest("hex");
  const backupStats = await stat(backupPath);
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("format" in manifest) ||
    !("sha256" in manifest) ||
    !("bytes" in manifest) ||
    manifest.format !== "lore-postgres-backup-v1" ||
    manifest.sha256 !== checksum ||
    manifest.bytes !== backupStats.size
  ) {
    throw new Error("Backup manifest or checksum is invalid");
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public' AND relation.relkind = 'r'`,
    );
    if (existing.rows[0]?.count !== 0) {
      throw new Error("Restore target must be an empty database; no objects were changed");
    }
    await client.query(
      `DO $$
       DECLARE
         existing_role record;
       BEGIN
         FOR existing_role IN
           SELECT oid, rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                  rolinherit, rolreplication, rolbypassrls
           FROM pg_roles
           WHERE rolname IN ('lore_app', 'lore_maintenance')
         LOOP
           IF existing_role.rolcanlogin OR existing_role.rolsuper OR
              existing_role.rolcreatedb OR existing_role.rolcreaterole OR
              existing_role.rolinherit OR existing_role.rolreplication OR
              existing_role.rolbypassrls OR EXISTS (
                SELECT 1 FROM pg_auth_members membership
                WHERE membership.member = existing_role.oid
                   OR membership.roleid = existing_role.oid
              ) THEN
             RAISE EXCEPTION 'Existing role % has unsafe attributes or memberships',
               existing_role.rolname;
           END IF;
         END LOOP;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_app') THEN
           CREATE ROLE lore_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
             NOINHERIT NOREPLICATION NOBYPASSRLS;
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lore_maintenance') THEN
           CREATE ROLE lore_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
             NOINHERIT NOREPLICATION NOBYPASSRLS;
         END IF;
       END
       $$`,
    );
  } finally {
    await client.end();
  }

  await new Promise<void>((resolveProcess, reject) => {
    const restoreUrl = new URL(databaseUrl);
    const restorePassword = decodeURIComponent(restoreUrl.password);
    restoreUrl.password = "";
    const child = spawn(
      "pg_restore",
      ["--exit-on-error", "--no-owner", "--dbname", restoreUrl.toString(), backupPath],
      {
        env: { ...process.env, ...(restorePassword ? { PGPASSWORD: restorePassword } : {}) },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveProcess() : reject(new Error(`pg_restore exited with status ${code}`)),
    );
  });

  const verifier = new pg.Client({ connectionString: databaseUrl });
  await verifier.connect();
  try {
    const row = await verifyRestoredDatabase((sql) => verifier.query<RestoredDatabaseState>(sql));
    console.log(JSON.stringify({ status: "verified", database: databaseName, ...row }));
  } finally {
    await verifier.end();
  }
}

if (import.meta.main) await restoreDatabase();
