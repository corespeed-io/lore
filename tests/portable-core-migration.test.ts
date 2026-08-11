import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, test } from "vitest";
import * as schema from "@/lib/db/schema";

const migrationsFolder = new URL("../db/drizzle", import.meta.url).pathname;

test("Drizzle baseline creates the complete Lore schema and is replay-safe", async () => {
  const postgres = new PGlite({ extensions: { vector } });
  try {
    await postgres.waitReady;
    const database = drizzle({ client: postgres, schema });
    await migrate(database, { migrationsFolder });
    await migrate(database, { migrationsFolder });

    const state = await database.execute<{
      journal_rows: number;
      legacy_ledger: string | null;
      policy_count: number;
      product_tables: number;
      rls_enabled_tables: number;
      schema_revision: number;
    }>(sql`SELECT
      (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS journal_rows,
      to_regclass('public.schema_migrations')::text AS legacy_ledger,
      (SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'public') AS policy_count,
      (SELECT count(*)::integer FROM pg_tables WHERE schemaname = 'public') AS product_tables,
      (SELECT count(*)::integer
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind = 'r'
          AND relation.relrowsecurity) AS rls_enabled_tables,
      (SELECT schema_revision FROM lore_system_state WHERE singleton) AS schema_revision`);

    expect(state.rows).toEqual([
      {
        journal_rows: 1,
        legacy_ledger: null,
        policy_count: 56,
        product_tables: 27,
        rls_enabled_tables: 26,
        schema_revision: 9,
      },
    ]);
  } finally {
    await postgres.close();
  }
});
