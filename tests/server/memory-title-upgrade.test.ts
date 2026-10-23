import { PGlite } from "@electric-sql/pglite";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import { migrationFiles } from "../../scripts/database/lib/migration-preflight.ts";
import { migrationQueries } from "../../scripts/database/lib/migration-statements.ts";

// Revisions 15 to 17 add Memory titles and glosses: 0015 the columns, rules, and
// functions, 0016 the copy of metadata.title and the rule validation, 0017 the name
// indexes. These tests upgrade a revision-14 database that holds data to revision 17,
// and run what an application of revision 14 sends against the result.

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";

const MEMORIES = {
  titled: "30000000-0000-4000-8000-000000000001",
  padded: "30000000-0000-4000-8000-000000000002",
  multiline: "30000000-0000-4000-8000-000000000003",
  long: "30000000-0000-4000-8000-000000000004",
  numeric: "30000000-0000-4000-8000-000000000005",
  blank: "30000000-0000-4000-8000-000000000006",
  untitled: "30000000-0000-4000-8000-000000000007",
} as const;

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

/** A revision-14 database with Memories whose metadata titles vary, and a waiting job. */
async function revision14WithData() {
  const postgres = await database();
  await applyMigrations(postgres, (number) => number <= 14);
  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, 'Alice')", [USER_ID]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Lab')", [WORKSPACE_ID]);
  const metadata: Record<keyof typeof MEMORIES, Record<string, unknown>> = {
    titled: { title: "Launch plan", type: "plan" },
    padded: { title: " \u3000Padded title\t " },
    multiline: { title: "Two\nlines" },
    long: { title: "x".repeat(257) },
    numeric: { title: 42 },
    blank: { title: "\u3000 " },
    untitled: { type: "note" },
  };
  for (const [key, id] of Object.entries(MEMORIES)) {
    await postgres.query(
      `INSERT INTO memories (id, workspace_id, owner_user_id, content, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, '2026-09-01T00:00:00Z')`,
      [id, WORKSPACE_ID, USER_ID, `Content of ${key}.`, JSON.stringify(metadata[key as never])],
    );
  }
  // A job still waiting for version 1 of a Memory the copy will title.
  await postgres.query(
    `INSERT INTO memory_embedding_jobs (
       id, workspace_id, memory_id, owner_user_id, memory_scope, memory_version,
       embedding_provider, embedding_model, embedding_revision, generation_id
     )
     SELECT gen_random_uuid(), $1, $2, $3, 'shared', 1, 'test', 'model', 'rev', generation.id
     FROM lore.ensure_embedding_generation('test', 'model', 1024, 'rev') generation`,
    [WORKSPACE_ID, MEMORIES.titled, USER_ID],
  );
  return postgres;
}

test("0016 copies each valid metadata.title, advances its version, and moves its waiting job", async () => {
  const postgres = await revision14WithData();
  await applyMigrations(postgres, (number) => number >= 15 && number <= 17);

  expect(
    await rows(postgres, "SELECT schema_revision, compatible_from FROM lore_system_state"),
  ).toEqual([{ schema_revision: 17, compatible_from: 9 }]);
  const memories = await rows<{
    id: string;
    title: string | null;
    version: number;
    metadata: Record<string, unknown>;
    updated: string;
  }>(
    postgres,
    `SELECT id, title, version, metadata, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated
     FROM memories ORDER BY id`,
  );
  expect(
    memories.map(({ id, title, version, updated }) => ({ id, title, version, updated })),
  ).toEqual([
    { id: MEMORIES.titled, title: "Launch plan", version: 2, updated: "2026-09-01" },
    // Trimmed as the UI trimmed it.
    { id: MEMORIES.padded, title: "Padded title", version: 2, updated: "2026-09-01" },
    // Titles the rule refuses stay only in metadata, and their Memories are untouched.
    { id: MEMORIES.multiline, title: null, version: 1, updated: "2026-09-01" },
    { id: MEMORIES.long, title: null, version: 1, updated: "2026-09-01" },
    { id: MEMORIES.numeric, title: null, version: 1, updated: "2026-09-01" },
    { id: MEMORIES.blank, title: null, version: 1, updated: "2026-09-01" },
    { id: MEMORIES.untitled, title: null, version: 1, updated: "2026-09-01" },
  ]);
  // Metadata stays exactly as written.
  expect(memories[0]?.metadata).toEqual({ title: "Launch plan", type: "plan" });
  expect(memories[1]?.metadata).toEqual({ title: " \u3000Padded title\t " });

  expect(
    await rows(postgres, "SELECT memory_id, memory_version, status FROM memory_embedding_jobs"),
  ).toEqual([{ memory_id: MEMORIES.titled, memory_version: 2, status: "pending" }]);
  expect(
    await rows(
      postgres,
      `SELECT resource_id, before_version, after_version, changed_fields, actor_user_id
       FROM memory_events WHERE event_type = 'memory.updated' ORDER BY resource_id`,
    ),
  ).toEqual([
    {
      resource_id: MEMORIES.titled,
      before_version: 1,
      after_version: 2,
      changed_fields: ["title"],
      actor_user_id: null,
    },
    {
      resource_id: MEMORIES.padded,
      before_version: 1,
      after_version: 2,
      changed_fields: ["title"],
      actor_user_id: null,
    },
  ]);
  // Every rule is validated, and every title index is built and valid.
  expect(
    await rows(
      postgres,
      `SELECT conname AS name, convalidated AS validated FROM pg_constraint
       WHERE conname IN (
         'memories_title_check', 'memories_gloss_check',
         'memory_proposals_proposed_title_check', 'memory_proposals_title_change_check',
         'memory_proposals_proposed_gloss_check', 'memory_proposals_gloss_change_check',
         'memory_proposals_check1'
       ) ORDER BY conname`,
    ),
  ).toEqual([
    { name: "memories_gloss_check", validated: true },
    { name: "memories_title_check", validated: true },
    { name: "memory_proposals_check1", validated: true },
    { name: "memory_proposals_gloss_change_check", validated: true },
    { name: "memory_proposals_proposed_gloss_check", validated: true },
    { name: "memory_proposals_proposed_title_check", validated: true },
    { name: "memory_proposals_title_change_check", validated: true },
  ]);
  expect(
    await rows(
      postgres,
      `SELECT class.relname AS name, index.indisvalid AS valid
       FROM pg_index index JOIN pg_class class ON class.oid = index.indexrelid
       WHERE class.relname LIKE 'memories_workspace_name_%' ORDER BY class.relname`,
    ),
  ).toEqual([
    { name: "memories_workspace_name_cjk_grams_idx", valid: true },
    { name: "memories_workspace_name_search_english_idx", valid: true },
    { name: "memories_workspace_name_search_idx", valid: true },
  ]);
});

test("what an application of revision 14 sends still works on revision 17", async () => {
  const postgres = await revision14WithData();
  await applyMigrations(postgres, (number) => number >= 15 && number <= 17);
  // Its insert names no title, and its update leaves the title alone.
  await postgres.query(
    `INSERT INTO memories (id, workspace_id, owner_user_id, created_by_agent_id, scope, content, metadata)
     VALUES (gen_random_uuid(), $1, $2, NULL, 'shared', 'Written by an older instance.', '{}')`,
    [WORKSPACE_ID, USER_ID],
  );
  await postgres.query(
    `UPDATE memories
     SET content = COALESCE($3::text, content), scope = COALESCE($4::memory_scope, scope),
         metadata = COALESCE($5::jsonb, metadata), version = version + 1, updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND version = $6`,
    [MEMORIES.titled, WORKSPACE_ID, "Changed by an older instance.", null, null, 2],
  );
  expect(
    await rows(postgres, "SELECT title, version FROM memories WHERE id = $1", [MEMORIES.titled]),
  ).toEqual([{ title: "Launch plan", version: 3 }]);
  // Its 13-argument submission still works and proposes no title or gloss.
  await postgres.query(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [WORKSPACE_ID, USER_ID],
  );
  await postgres.exec("BEGIN");
  await postgres.query(
    `SELECT set_config('lore.workspace_id', $1, true), set_config('lore.user_id', $2, true),
            set_config('lore.agent_id', '', true)`,
    [WORKSPACE_ID, USER_ID],
  );
  const proposals = await rows<{
    proposed_title: string | null;
    changes_title: boolean;
    proposed_gloss: string | null;
    changes_gloss: boolean;
  }>(
    postgres,
    `SELECT proposed_title, changes_title, proposed_gloss, changes_gloss
     FROM lore.submit_memory_proposal(
       $1, $2, 'human', NULL, 'update', $3, 3, 'Proposed by an older instance.', 'shared',
       '{"title":"Launch plan","type":"plan"}'::jsonb, true, false, false
     )`,
    [WORKSPACE_ID, USER_ID, MEMORIES.titled],
  );
  await postgres.exec("COMMIT");
  expect(proposals).toEqual([
    { proposed_title: null, changes_title: false, proposed_gloss: null, changes_gloss: false },
  ]);
  // Its search calls the same signature and now gets the title channels too.
  await postgres.query(
    `INSERT INTO memory_chunks (id, workspace_id, memory_id, ordinal, content, chunking_revision)
     VALUES (gen_random_uuid(), $1, $2, 0, 'Changed by an older instance.', 'lore-memory-chunking-v2')`,
    [WORKSPACE_ID, MEMORIES.titled],
  );
  await postgres.exec("BEGIN");
  await postgres.query(
    `SELECT set_config('lore.workspace_id', $1, true), set_config('lore.user_id', $2, true),
            set_config('lore.agent_id', '', true)`,
    [WORKSPACE_ID, USER_ID],
  );
  const channels = await rows<{ channel: string; memory_id: string }>(
    postgres,
    `SELECT channel, memory_id FROM lore.lexical_candidates(
       $1, 'launch plan', ARRAY['launch', 'plan'], ARRAY[]::text[], 0, NULL, NULL, NULL, NULL,
       ARRAY[]::uuid[], 10
     ) ORDER BY channel`,
    [WORKSPACE_ID],
  );
  await postgres.exec("COMMIT");
  expect(channels).toEqual([
    { channel: "name_english", memory_id: MEMORIES.titled },
    { channel: "name_relaxed_english", memory_id: MEMORIES.titled },
    { channel: "name_simple", memory_id: MEMORIES.titled },
  ]);
});
