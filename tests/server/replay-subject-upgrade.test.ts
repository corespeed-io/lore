import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import { migrationFiles } from "../../scripts/database/lib/migration-preflight.ts";
import { migrationQueries } from "../../scripts/database/lib/migration-statements.ts";

// Revision 7 adds the replay ledger's subject columns without rewriting the ledger:
// rows an older release wrote keep NULL columns, and the baseline JSON-path triggers
// scrub them (tests/server/replay-scrub.test.ts proves that scrub alone). This applies
// 0001-0006, seeds those rows, then applies the rest, as an upgrade does, and then
// replays the pre-revision-7 reclaim of an expired key against the upgraded ledger.

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const MEMORY_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_MEMORY_ID = "30000000-0000-4000-8000-000000000002";

const NO_SUBJECTS = {
  subject_memory_id: null,
  subject_proposal_id: null,
  proposal_target_memory_id: null,
  proposal_accepted_memory_id: null,
  subject_episode_id: null,
};

async function applyMigrations(postgres: PGlite, include: (number: number) => boolean) {
  for (const migration of await migrationFiles()) {
    if (!include(Number.parseInt(migration.id, 10))) continue;
    for (const query of migrationQueries(migration.sql, migration.id)) await postgres.exec(query);
  }
}

async function subjects(postgres: PGlite) {
  const result = await postgres.query<Record<string, string | null>>(
    `SELECT idempotency_key, subject_memory_id, subject_proposal_id,
            proposal_target_memory_id, proposal_accepted_memory_id, subject_episode_id
     FROM request_idempotency_records ORDER BY idempotency_key`,
  );
  return result.rows;
}

test("an upgrade leaves older replay rows to the JSON-path scrub, and a reclaim clears stale subjects", async () => {
  const postgres = await PGlite.create({ extensions: { pg_trgm, vector } });
  onTestFinished(() => postgres.close());
  await applyMigrations(postgres, (number) => number <= 6);

  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, 'Alice')", [USER_ID]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Upgrade')", [WORKSPACE_ID]);
  await postgres.query(
    `INSERT INTO request_idempotency_records (
       id, workspace_id, actor_user_id, actor_kind, actor_id, operation,
       idempotency_key, request_sha256, status, response_status, response_body, completed_at
     ) VALUES (gen_random_uuid(), $1, $2, 'user', $2, 'memory.create', 'older', $3,
               'completed', 201, $4, now())`,
    [WORKSPACE_ID, USER_ID, "0".repeat(64), JSON.stringify({ memory: { id: MEMORY_ID } })],
  );

  await applyMigrations(postgres, (number) => number > 6);

  // No backfill: the row an older release wrote names no subject in a column.
  expect(await subjects(postgres)).toEqual([{ idempotency_key: "older", ...NO_SUBJECTS }]);
  const revision = await postgres.query<{ schema_revision: number }>(
    "SELECT schema_revision FROM lore_system_state WHERE singleton",
  );
  expect(revision.rows).toEqual([{ schema_revision: 9 }]);

  // A newer instance completes a key and records its subject.
  await postgres.query(
    `INSERT INTO request_idempotency_records (
       id, workspace_id, actor_user_id, actor_kind, actor_id, operation,
       idempotency_key, request_sha256, status, response_status, response_body, completed_at,
       subject_memory_id, expires_at
     ) VALUES (gen_random_uuid(), $1, $2, 'user', $2, 'memory.create', 'reclaimed', $3,
               'completed', 201, $4, now(), $5, now() - interval '1 second')`,
    [
      WORKSPACE_ID,
      USER_ID,
      "0".repeat(64),
      JSON.stringify({ memory: { id: MEMORY_ID } }),
      MEMORY_ID,
    ],
  );
  // After it expires, an instance from before revision 7 reclaims and completes it with
  // the statements that release runs, which name no subject column.
  await postgres.query(
    `UPDATE request_idempotency_records
     SET request_sha256 = $2,
         status = 'in_progress',
         response_status = NULL,
         response_body = NULL,
         completed_at = NULL,
         created_at = now(),
         expires_at = now() + interval '24 hours'
     WHERE idempotency_key = $1`,
    ["reclaimed", "1".repeat(64)],
  );
  await postgres.query(
    `UPDATE request_idempotency_records
     SET status = 'completed', response_status = $2, response_body = $3::jsonb, completed_at = now()
     WHERE idempotency_key = $1 AND status = 'in_progress'`,
    ["reclaimed", 201, JSON.stringify({ memory: { id: OTHER_MEMORY_ID } })],
  );

  // The row now carries another Memory; the stale column is gone, so forgetting the
  // first Memory cannot delete it, and the JSON paths still find the Memory it carries.
  expect(await subjects(postgres)).toEqual([
    { idempotency_key: "older", ...NO_SUBJECTS },
    { idempotency_key: "reclaimed", ...NO_SUBJECTS },
  ]);
}, 60_000);
