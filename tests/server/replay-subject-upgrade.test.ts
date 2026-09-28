import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import {
  LATEST_SCHEMA_REVISION,
  migrationFiles,
} from "../../scripts/database/lib/migration-preflight.ts";
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

test("an upgrade does not backfill older replay rows, and a reclaim clears stale subjects", async () => {
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
  expect(revision.rows).toEqual([{ schema_revision: LATEST_SCHEMA_REVISION }]);

  // A newer instance completes a key and records its subjects, one value in every
  // column so the reclaim below must clear each of them.
  await postgres.query(
    `INSERT INTO request_idempotency_records (
       id, workspace_id, actor_user_id, actor_kind, actor_id, operation,
       idempotency_key, request_sha256, status, response_status, response_body, completed_at,
       subject_memory_id, subject_proposal_id, proposal_target_memory_id,
       proposal_accepted_memory_id, subject_episode_id, expires_at
     ) VALUES (gen_random_uuid(), $1, $2, 'user', $2, 'memory.create', 'reclaimed', $3,
               'completed', 201, $4, now(), $5, $5, $5, $5, $5, now() - interval '1 second')`,
    [
      WORKSPACE_ID,
      USER_ID,
      "0".repeat(64),
      JSON.stringify({ memory: { id: MEMORY_ID } }),
      MEMORY_ID,
    ],
  );
  const every = {
    subject_memory_id: MEMORY_ID,
    subject_proposal_id: MEMORY_ID,
    proposal_target_memory_id: MEMORY_ID,
    proposal_accepted_memory_id: MEMORY_ID,
    subject_episode_id: MEMORY_ID,
  };
  // An update that leaves a completed row completed keeps its subjects.
  await postgres.query(
    "UPDATE request_idempotency_records SET expires_at = expires_at WHERE idempotency_key = $1",
    ["reclaimed"],
  );
  expect((await subjects(postgres)).at(1)).toEqual({ idempotency_key: "reclaimed", ...every });
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

  // The row now carries another Memory and names no subject in a column, so the
  // column scrub cannot delete it when the first Memory is forgotten; the JSON-path
  // scrub (proved alone in replay-scrub.test.ts) finds the Memory it carries.
  expect(await subjects(postgres)).toEqual([
    { idempotency_key: "older", ...NO_SUBJECTS },
    { idempotency_key: "reclaimed", ...NO_SUBJECTS },
  ]);
}, 60_000);

// Every keyed write claims its ledger row before it writes a Memory, Proposal, or
// Episode, and Agent deletion's foreign keys reach Episodes before Memories, so a
// migration that holds a subject table while it waits for the ledger, or takes the
// subject tables out of that order, can deadlock with live writes. This applies each
// migration inside a transaction and reads the table locks it took before rolling back.
test.each([
  ["0007", ["lore_system_state", "request_idempotency_records"]],
  ["0009", ["episodes", "lore_system_state", "memories", "memory_proposals"]],
])(
  "%s locks only the tables it must",
  async (version, expected) => {
    const postgres = await PGlite.create({ extensions: { pg_trgm, vector } });
    onTestFinished(() => postgres.close());
    const target = Number.parseInt(version, 10);
    await applyMigrations(postgres, (number) => number < target);
    const migration = (await migrationFiles()).find((file) => file.version === version);
    if (!migration) throw new Error(`missing migration ${version}`);

    await postgres.exec("BEGIN");
    for (const query of migrationQueries(migration.sql, migration.id)) await postgres.exec(query);
    const locked = await postgres.query<{ relname: string }>(
      `SELECT DISTINCT class.relname
     FROM pg_locks lock
     JOIN pg_class class ON class.oid = lock.relation
     JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
     WHERE lock.pid = pg_backend_pid() AND namespace.nspname = 'public' AND class.relkind = 'r'
     ORDER BY class.relname`,
    );
    await postgres.exec("ROLLBACK");
    expect(locked.rows.map((row) => row.relname)).toEqual(expected);
  },
  60_000,
);
