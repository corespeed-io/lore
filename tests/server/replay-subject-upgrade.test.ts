import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import { migrationFiles } from "../../scripts/database/lib/migration-preflight.ts";
import { migrationQueries } from "../../scripts/database/lib/migration-statements.ts";

// Migration 0007 fills the replay ledger's new subject columns for rows an older
// release wrote. This applies 0001-0006, seeds those rows, then applies the rest,
// as an upgrade does.

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const MEMORY_ID = "30000000-0000-4000-8000-000000000001";
const PROPOSAL_ID = "40000000-0000-4000-8000-000000000001";
const TARGET_ID = "30000000-0000-4000-8000-000000000002";
const ACCEPTED_ID = "30000000-0000-4000-8000-000000000003";
const EPISODE_ID = "50000000-0000-4000-8000-000000000001";

async function applyMigrations(postgres: PGlite, include: (number: number) => boolean) {
  for (const migration of await migrationFiles()) {
    if (!include(Number.parseInt(migration.id, 10))) continue;
    for (const query of migrationQueries(migration.sql, migration.id)) await postgres.exec(query);
  }
}

test("0007 names the subjects of the replay rows an older release wrote", async () => {
  const postgres = await PGlite.create({ extensions: { pg_trgm, vector } });
  onTestFinished(() => postgres.close());
  await applyMigrations(postgres, (number) => number <= 6);

  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, 'Alice')", [USER_ID]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Upgrade')", [WORKSPACE_ID]);
  const rows: Array<[string, unknown]> = [
    ["memory", { memory: { id: MEMORY_ID, content: "old" } }],
    [
      "proposal",
      { proposal: { id: PROPOSAL_ID, targetMemoryId: TARGET_ID, acceptedMemoryId: ACCEPTED_ID } },
    ],
    ["episode", { episode: { id: EPISODE_ID } }],
    ["forget", { deleted: true }],
    ["not-found", { memory: null }],
    // Nothing the application wrote looks like this, but it must not stop the upgrade.
    ["malformed", { memory: { id: "-".repeat(36) }, episode: { id: 7 } }],
  ];
  for (const [key, body] of rows) {
    await postgres.query(
      `INSERT INTO request_idempotency_records (
         id, workspace_id, actor_user_id, actor_kind, actor_id, operation,
         idempotency_key, request_sha256, status, response_status, response_body, completed_at
       ) VALUES (gen_random_uuid(), $1, $2, 'user', $2, 'test', $3, $4, 'completed', 200, $5, now())`,
      [WORKSPACE_ID, USER_ID, key, "0".repeat(64), JSON.stringify(body)],
    );
  }
  await postgres.query(
    `INSERT INTO request_idempotency_records (
       id, workspace_id, actor_user_id, actor_kind, actor_id, operation,
       idempotency_key, request_sha256
     ) VALUES (gen_random_uuid(), $1, $2, 'user', $2, 'test', 'in-progress', $3)`,
    [WORKSPACE_ID, USER_ID, "0".repeat(64)],
  );

  await applyMigrations(postgres, (number) => number > 6);

  const result = await postgres.query<Record<string, string | null>>(
    `SELECT idempotency_key, subject_memory_id, subject_proposal_id,
            proposal_target_memory_id, proposal_accepted_memory_id, subject_episode_id
     FROM request_idempotency_records ORDER BY idempotency_key`,
  );
  const none = {
    subject_memory_id: null,
    subject_proposal_id: null,
    proposal_target_memory_id: null,
    proposal_accepted_memory_id: null,
    subject_episode_id: null,
  };
  expect(result.rows).toEqual([
    { idempotency_key: "episode", ...none, subject_episode_id: EPISODE_ID },
    { idempotency_key: "forget", ...none },
    { idempotency_key: "in-progress", ...none },
    { idempotency_key: "malformed", ...none },
    { idempotency_key: "memory", ...none, subject_memory_id: MEMORY_ID },
    { idempotency_key: "not-found", ...none },
    {
      idempotency_key: "proposal",
      ...none,
      subject_proposal_id: PROPOSAL_ID,
      proposal_target_memory_id: TARGET_ID,
      proposal_accepted_memory_id: ACCEPTED_ID,
    },
  ]);
  const revision = await postgres.query<{ schema_revision: number }>(
    "SELECT schema_revision FROM lore_system_state WHERE singleton",
  );
  expect(revision.rows).toEqual([{ schema_revision: 8 }]);
}, 60_000);
