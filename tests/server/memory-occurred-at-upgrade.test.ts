import { PGlite } from "@electric-sql/pglite";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import { migrationFiles } from "../../scripts/database/lib/migration-preflight.ts";
import { migrationQueries } from "../../scripts/database/lib/migration-statements.ts";

// Revisions 18 and 19 add when a Memory's event happened: 0018 the column, its
// Proposal counterparts, its rules NOT VALID, the outbox, the review guard, and the
// capability; 0019 validates the rules. These tests upgrade a revision-17 database
// that holds data, and run what an application of revision 17 sends against the result.

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const MEMORY_ID = "30000000-0000-4000-8000-000000000001";
const OLDER_MEMORY_ID = "30000000-0000-4000-8000-000000000002";

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

async function rows<T>(postgres: PGlite, sql: string, params: unknown[] = []) {
  return (await postgres.query<T>(sql, params)).rows;
}

/** Run statements as the human owner, the way a request installs its Actor. */
async function asOwner<T>(postgres: PGlite, run: () => Promise<T>): Promise<T> {
  await postgres.exec("BEGIN");
  try {
    await postgres.query(
      `SELECT set_config('lore.workspace_id', $1, true), set_config('lore.user_id', $2, true),
              set_config('lore.agent_id', '', true)`,
      [WORKSPACE_ID, USER_ID],
    );
    const result = await run();
    await postgres.exec("COMMIT");
    return result;
  } catch (error) {
    await postgres.exec("ROLLBACK");
    throw error;
  }
}

/** A revision-17 database with a titled Memory and a pending update Proposal for it. */
async function revision17WithData() {
  const postgres = await database();
  await applyMigrations(postgres, (number) => number <= 17);
  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, 'Alice')", [USER_ID]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Lab')", [WORKSPACE_ID]);
  await postgres.query(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [WORKSPACE_ID, USER_ID],
  );
  await postgres.query(
    `INSERT INTO memories (id, workspace_id, owner_user_id, content, title, updated_at)
     VALUES ($1, $2, $3, 'The launch moved to Friday.', 'Launch date', '2026-09-01T00:00:00Z')`,
    [MEMORY_ID, WORKSPACE_ID, USER_ID],
  );
  await asOwner(postgres, () =>
    postgres.query(
      `SELECT id FROM lore.submit_memory_proposal(
         $1, $2, 'human', NULL, 'update', $3, 1, 'The launch moved to Friday.', 'shared',
         '{}'::jsonb, false, false, false, 'Launch day', true, NULL, false
       )`,
      [WORKSPACE_ID, USER_ID, MEMORY_ID],
    ),
  );
  return postgres;
}

test("0018 and 0019 add occurred_at without touching a row, and validate its rules", async () => {
  const postgres = await revision17WithData();
  await applyMigrations(postgres, (number) => number >= 18);

  expect(
    await rows(postgres, "SELECT schema_revision, compatible_from FROM lore_system_state"),
  ).toEqual([{ schema_revision: 19, compatible_from: 9 }]);
  // Existing Memories keep their version and updated_at, and gain no time.
  expect(
    await rows(
      postgres,
      `SELECT occurred_at, version, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated
       FROM memories`,
    ),
  ).toEqual([{ occurred_at: null, version: 1, updated: "2026-09-01" }]);
  expect(
    await rows(
      postgres,
      "SELECT count(*)::int AS events FROM memory_events WHERE event_type = 'memory.updated'",
    ),
  ).toEqual([{ events: 0 }]);
  // A Proposal stored before 0018 proposes no time.
  expect(
    await rows(
      postgres,
      "SELECT proposed_title, proposed_occurred_at, changes_occurred_at FROM memory_proposals",
    ),
  ).toEqual([
    { proposed_title: "Launch day", proposed_occurred_at: null, changes_occurred_at: false },
  ]);
  expect(
    await rows(
      postgres,
      `SELECT conname AS name, convalidated AS validated FROM pg_constraint
       WHERE conname IN (
         'memories_occurred_at_check', 'memory_proposals_proposed_occurred_at_check',
         'memory_proposals_occurred_at_change_check', 'memory_proposals_check1'
       ) ORDER BY conname`,
    ),
  ).toEqual([
    { name: "memories_occurred_at_check", validated: true },
    { name: "memory_proposals_check1", validated: true },
    { name: "memory_proposals_occurred_at_change_check", validated: true },
    { name: "memory_proposals_proposed_occurred_at_check", validated: true },
  ]);
  const [capabilities] = await rows<{ features: Record<string, unknown> }>(
    postgres,
    "SELECT lore.portable_core_capabilities() -> 'features' AS features",
  );
  expect(capabilities?.features).toMatchObject({ memoryOccurredAt: true, memoryTitles: true });

  // The rule holds the four-digit UTC years, as validateMemoryOccurredAt does.
  await postgres.query("UPDATE memories SET occurred_at = '0001-01-01T00:00:00Z' WHERE id = $1", [
    MEMORY_ID,
  ]);
  await postgres.query(
    "UPDATE memories SET occurred_at = '9999-12-31T23:59:59.999999Z' WHERE id = $1",
    [MEMORY_ID],
  );
  for (const outside of ["10000-01-01T00:00:00Z", "0001-01-01T00:30:00+01:00"]) {
    await expect(
      postgres.query("UPDATE memories SET occurred_at = $2 WHERE id = $1", [MEMORY_ID, outside]),
    ).rejects.toThrow(/memories_occurred_at_check/);
  }
  // Each change is in the outbox.
  expect(
    await rows<{ changed_fields: string[] }>(
      postgres,
      `SELECT changed_fields FROM memory_events
       WHERE event_type = 'memory.updated' ORDER BY created_at, after_version`,
    ),
  ).toEqual([{ changed_fields: ["occurred_at"] }, { changed_fields: ["occurred_at"] }]);
});

test("what an application of revision 17 sends still works on revision 19", async () => {
  const postgres = await revision17WithData();
  await applyMigrations(postgres, (number) => number >= 18);
  await postgres.query(
    "UPDATE memories SET occurred_at = '2026-08-28T09:00:00Z', version = version + 1 WHERE id = $1",
    [MEMORY_ID],
  );

  // Its insert names no time, and its update leaves the time alone.
  await postgres.query(
    `INSERT INTO memories (
       id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata, title, gloss
     ) VALUES ($1, $2, $3, NULL, 'shared', 'Written by an older instance.', '{}', NULL, NULL)`,
    [OLDER_MEMORY_ID, WORKSPACE_ID, USER_ID],
  );
  await postgres.query(
    `UPDATE memories
     SET content = COALESCE($3::text, content), scope = COALESCE($4::memory_scope, scope),
         metadata = COALESCE($5::jsonb, metadata),
         title = CASE WHEN $7::boolean THEN $8::text ELSE title END,
         gloss = CASE WHEN $9::boolean THEN $10::text ELSE gloss END,
         version = version + 1, updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND version = $6`,
    [
      MEMORY_ID,
      WORKSPACE_ID,
      "Changed by an older instance.",
      null,
      null,
      2,
      false,
      null,
      false,
      null,
    ],
  );
  expect(
    await rows(
      postgres,
      `SELECT id, occurred_at IS NOT NULL AS dated, version FROM memories ORDER BY id`,
    ),
  ).toEqual([
    { id: MEMORY_ID, dated: true, version: 3 },
    { id: OLDER_MEMORY_ID, dated: false, version: 1 },
  ]);

  // Its 17-argument submission still works and proposes no time.
  const submitted = await asOwner(postgres, () =>
    rows<{ changes_occurred_at: boolean; proposed_occurred_at: string | null }>(
      postgres,
      `SELECT changes_occurred_at, proposed_occurred_at FROM lore.submit_memory_proposal(
         $1, $2, 'human', NULL, 'create', NULL, NULL, 'Proposed by an older instance.', 'shared',
         '{}'::jsonb, true, true, true, NULL, true, NULL, true
       )`,
      [WORKSPACE_ID, USER_ID],
    ),
  );
  expect(submitted).toEqual([{ changes_occurred_at: false, proposed_occurred_at: null }]);

  // A create Proposal that sets a time, submitted by this release.
  const [dated] = await asOwner(postgres, () =>
    rows<{ id: string }>(
      postgres,
      `SELECT id FROM lore.submit_memory_proposal(
         $1, $2, 'human', NULL, 'create', NULL, NULL, 'The review happened on Monday.', 'shared',
         '{}'::jsonb, true, true, true, NULL, true, NULL, true, '2026-08-31T15:00:00Z', true
       )`,
      [WORKSPACE_ID, USER_ID],
    ),
  );
  if (!dated) throw new Error("The dated Proposal was not submitted");
  const accept = (memoryId: string) =>
    asOwner(postgres, () =>
      postgres.query(
        `UPDATE memory_proposals
         SET status = 'accepted', reviewed_by_user_id = $2, accepted_memory_id = $3,
             reviewed_at = now(), expires_at = now() + interval '30 days'
         WHERE id = $1`,
        [dated.id, USER_ID, memoryId],
      ),
    );
  const write = (memoryId: string, occurredAt: string | null) =>
    postgres.query(
      `INSERT INTO memories (
         id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata, title,
         gloss, occurred_at
       ) VALUES ($1, $2, $3, NULL, 'shared', 'The review happened on Monday.', '{}', NULL, NULL, $4)`,
      [memoryId, WORKSPACE_ID, USER_ID, occurredAt],
    );
  // An older instance would write the Memory without the time, so the guard refuses
  // its acceptance rather than let the time be lost.
  const withoutTime = "30000000-0000-4000-8000-000000000003";
  await write(withoutTime, null);
  await expect(accept(withoutTime)).rejects.toThrow(
    /Accepted create receipt must match the canonical Memory/,
  );
  const withTime = "30000000-0000-4000-8000-000000000004";
  await write(withTime, "2026-08-31T15:00:00Z");
  await accept(withTime);
  expect(
    await rows(postgres, "SELECT status, accepted_memory_id FROM memory_proposals WHERE id = $1", [
      dated.id,
    ]),
  ).toEqual([{ status: "accepted", accepted_memory_id: withTime }]);
});
