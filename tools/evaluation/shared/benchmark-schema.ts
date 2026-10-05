import type pg from "pg";
import { LATEST_SCHEMA_REVISION } from "../../../scripts/database/lib/migration-preflight.ts";

/**
 * Refuses a benchmark database whose Lore migrations have not all been applied.
 * Benchmarks write through the native modules, so the schema must be the one this
 * checkout's migrations produce. The sentinel is the published schema revision,
 * not an index or column a later migration may drop.
 */
export async function requireMigratedBenchmarkSchema(admin: Pick<pg.Client, "query">) {
  const installed = await admin.query<{ capabilities: string | null }>(
    "SELECT to_regprocedure('lore.portable_core_capabilities()')::text AS capabilities",
  );
  const revision = installed.rows[0]?.capabilities
    ? Number(
        (
          await admin.query<{ revision: string | null }>(
            "SELECT lore.portable_core_capabilities()->>'schemaRevision' AS revision",
          )
        ).rows[0]?.revision,
      )
    : null;
  if (revision !== LATEST_SCHEMA_REVISION) {
    throw new Error(
      `Lore migrations are missing (schema revision ${revision ?? "none"}, expected ${LATEST_SCHEMA_REVISION}); run DATABASE_URL=$BENCHMARK_DATABASE_URL bun run db:migrate first`,
    );
  }
}
