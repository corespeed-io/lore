import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  type MemoryCoreContractFixture,
  runMemoryCoreContractSuite,
  testDatabaseForRole,
} from "../src/testing";

/**
 * The engine's own contract run uses lore oss's migration chain and identity
 * model: users/workspaces/memberships rows satisfy the membership-consulting
 * RLS policy bodies. A host with different policy bodies (for example HaaS's
 * pure-GUC comparisons) points the same suite at its own chain and seeds
 * nothing but actor ids.
 */

const ALICE = "10000000-0000-4000-8000-000000000001";
const BOB = "10000000-0000-4000-8000-000000000002";
const CAROL = "10000000-0000-4000-8000-000000000003";
const OPERATIONS = "20000000-0000-4000-8000-000000000001";
const RESEARCH = "20000000-0000-4000-8000-000000000002";

const migrationsUrl = new URL("../../../db/migrations/", import.meta.url);

async function createLoreFixture(): Promise<MemoryCoreContractFixture> {
  const postgres = new PGlite({ extensions: { pg_trgm, vector } });
  await postgres.waitReady;
  const migrationIds = (await readdir(migrationsUrl))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migrationId of migrationIds) {
    await postgres.exec(await readFile(new URL(migrationId, migrationsUrl), "utf8"));
  }
  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4), ($5, $6)", [
    ALICE,
    "Alice",
    BOB,
    "Bob",
    CAROL,
    "Carol",
  ]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)", [
    OPERATIONS,
    "Operations",
    RESEARCH,
    "Research",
  ]);
  await postgres.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [OPERATIONS, ALICE, BOB],
  );
  await postgres.query(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [RESEARCH, CAROL],
  );
  let closePromise: Promise<void> | undefined;
  return {
    database: testDatabaseForRole(postgres, "lore_app"),
    maintenanceDatabase: testDatabaseForRole(postgres, "lore_maintenance"),
    alice: { workspaceId: OPERATIONS, userId: ALICE },
    bob: { workspaceId: OPERATIONS, userId: BOB },
    carol: { workspaceId: RESEARCH, userId: CAROL },
    close: () => {
      closePromise ??= postgres.close();
      return closePromise;
    },
  };
}

runMemoryCoreContractSuite(createLoreFixture, {
  embeddingDimensions: 1024,
  defaultMemoryScope: "shared",
});
