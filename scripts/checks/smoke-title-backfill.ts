import assert from "node:assert/strict";
import { Client } from "pg";
import { migrationFiles } from "../database/lib/migration-preflight";
import { migrationQueries } from "../database/lib/migration-statements";
import {
  parseSmokeDatabaseUrl,
  requireFreshDatabase,
  waitForLockWaiters,
} from "./lib/smoke-database";

// 0016 copies metadata.title into title while requests may still write. A request
// that changes a Memory while the copy waits on its row must win: the copy has to
// judge and read the row as that request committed it, never as its own snapshot
// saw it. PGlite has one connection and cannot show this, so it runs on PostgreSQL,
// in a fresh, empty disposable database the caller owns, which it leaves at revision 16.

const smokeDatabaseUrl = process.env.LORE_SMOKE_DATABASE_URL;
if (!smokeDatabaseUrl) throw new Error("LORE_SMOKE_DATABASE_URL is required");
const { databaseName } = parseSmokeDatabaseUrl(smokeDatabaseUrl);
await requireFreshDatabase(smokeDatabaseUrl, databaseName);

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const MEMORIES = {
  /** A request titles it. */
  titled: "30000000-0000-4000-8000-000000000001",
  /** A request rewrites its metadata.title. */
  renamed: "30000000-0000-4000-8000-000000000002",
  /** A request makes its metadata.title break the title rule. */
  broken: "30000000-0000-4000-8000-000000000003",
  /** No request touches it. */
  untouched: "30000000-0000-4000-8000-000000000004",
} as const;

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: smokeDatabaseUrl });
  await client.connect();
  return client;
}

const migrations = await migrationFiles();
const backfill = migrations.find((migration) => migration.id.startsWith("0016_"));
if (!backfill) throw new Error("0016 is missing");
const admin = await connect();
const writer = await connect();
try {
  for (const migration of migrations) {
    if (Number.parseInt(migration.id, 10) > 15) continue;
    for (const query of migrationQueries(migration.sql, migration.id)) await admin.query(query);
  }
  await admin.query("INSERT INTO users (id, display_name) VALUES ($1, 'Alice')", [USER_ID]);
  await admin.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Lab')", [WORKSPACE_ID]);
  for (const [key, id] of Object.entries(MEMORIES)) {
    await admin.query(
      `INSERT INTO memories (id, workspace_id, owner_user_id, content, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, WORKSPACE_ID, USER_ID, `Content of ${key}.`, JSON.stringify({ title: `Old ${key}` })],
    );
  }

  // A request holds three of the rows, uncommitted, as 0016 starts.
  await writer.query("BEGIN");
  await writer.query(
    "UPDATE memories SET title = 'Request title', version = version + 1 WHERE id = $1",
    [MEMORIES.titled],
  );
  await writer.query(
    `UPDATE memories SET metadata = '{"title":"New renamed"}', version = version + 1
     WHERE id = $1`,
    [MEMORIES.renamed],
  );
  await writer.query(
    `UPDATE memories SET metadata = '{"title":"Two\\nlines"}', version = version + 1
     WHERE id = $1`,
    [MEMORIES.broken],
  );
  const copying = (async () => {
    for (const query of migrationQueries(backfill.sql, backfill.id)) await admin.query(query);
  })();
  await waitForLockWaiters(writer, 1);
  await writer.query("COMMIT");
  await copying;

  const rows = await admin.query<{ id: string; title: string | null; version: number }>(
    "SELECT id, title, version FROM memories ORDER BY id",
  );
  assert.deepEqual(rows.rows, [
    // The request's title stands; the copy skips a Memory that has one.
    { id: MEMORIES.titled, title: "Request title", version: 2 },
    // The copy reads metadata.title as the request committed it.
    { id: MEMORIES.renamed, title: "New renamed", version: 3 },
    // A metadata.title the request broke is not copied.
    { id: MEMORIES.broken, title: null, version: 2 },
    { id: MEMORIES.untouched, title: "Old untouched", version: 2 },
  ]);
  console.log("Title backfill smoke passed: 0016 yields to a request that commits during its wait");
} finally {
  await writer.end();
  await admin.end();
}
