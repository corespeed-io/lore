import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PostgresDatabase } from "@corespeed/lore-core";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, onTestFinished, test } from "vitest";
import { createCodeIndexMaintenanceModule } from "@/modules/code/indexing/maintenance";
import type { ConfiguredCodeRepositories } from "@/modules/code/indexing/queue";
import { createCodeIndexQueueModule } from "@/modules/code/indexing/queue";
import { createCodeIndexModule } from "@/modules/code/indexing/service";
import type { ActorContext } from "@/server/auth/actor-context";

// Migration 0004 cleans up Code Index state written before it. This test applies
// 0001-0003, seeds that state, then applies every later migration, as an upgrade does.

const execFileAsync = promisify(execFile);
const migrationsUrl = new URL("../../../db/migrations/", import.meta.url);

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "30000000-0000-4000-8000-000000000001";
const REPOSITORY_KEY = "corespeed/upgrade-cleanup";
const ALICE: ActorContext = { workspaceId: WORKSPACE_ID, userId: USER_ID };
/** CODE_INDEX_REVISION when 0004 ships, and the one before it. */
const V7_REVISION = "ast-grep-0.45.3-web-structural-graph-v7-exact-root-partition";
const V6_REVISION = "ast-grep-0.45.3-web-structural-graph-v6-derived-sets";
/** SHA-256 of the three bytes EF BB BF. */
const BOM_SHA256 = "f1945cd6c19e56b3c1c78943ef5ec18116907a4ca1efc40a57d48ab1db7adfc5";

const revision = (index: number) => `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const generation = (index: number) =>
  `50000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const job = (index: number) => `60000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const oid = (character: string) => character.repeat(40);

async function migrationFiles(): Promise<Array<{ number: number; name: string }>> {
  return (await readdir(migrationsUrl))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((name) => ({ number: Number.parseInt(name, 10), name }));
}

async function applyMigrations(postgres: PGlite, include: (number: number) => boolean) {
  for (const migration of await migrationFiles()) {
    if (!include(migration.number)) continue;
    await postgres.exec(await readFile(new URL(migration.name, migrationsUrl), "utf8"));
  }
}

function databaseForRole(
  postgres: PGlite,
  role: "lore_app" | "lore_maintenance",
): PostgresDatabase {
  return {
    transaction: (use) =>
      postgres.transaction(async (transaction) => {
        await transaction.query(`SET LOCAL ROLE ${role}`);
        return use({ query: (sql, params) => transaction.query(sql, params) });
      }),
  };
}

/** A real repository whose one commit holds a BOM-only blob beside ordinary source. */
async function bomRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "lore-upgrade-cleanup-"));
  onTestFinished(async () => {
    await rm(repositoryPath, { force: true, recursive: true });
  });
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  const files: Record<string, string | Uint8Array> = {
    "src/a.ts": 'export const upgradeMarker = "indexed after the cleanup";\n',
    "src/bom-only.ts": new Uint8Array([0xef, 0xbb, 0xbf]),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repositoryPath, path)), { recursive: true });
    await writeFile(join(repositoryPath, path), content);
  }
  await execFileAsync("git", ["-C", repositoryPath, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    repositoryPath,
    "-c",
    "user.name=Lore Test",
    "-c",
    "user.email=lore@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const { stdout } = await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
  return { repositoryPath, commitOid: stdout.trim() };
}

/**
 * Pre-0004 state, written as the owner. Revision 1 is the real BOM-only commit whose
 * pre-v7 building generation could never become ready; revisions 2-8 each differ from it
 * in exactly one respect that must keep them.
 */
function seedSql(bomCommitOid: string): string {
  const file = (index: number, path: string, status: "indexed" | "excluded", bom: boolean) =>
    `('${WORKSPACE_ID}', '${REPOSITORY_ID}', '${revision(index)}', '${path}', '100644', 'blob',
      '${oid("e")}', ${bom ? 3 : 20}, '${bom ? BOM_SHA256 : "a".repeat(64)}', '${status}',
      ${status === "excluded" ? "'empty'" : "NULL"})`;
  const revisionRow = (index: number, commitOid: string) =>
    `('${revision(index)}', '${WORKSPACE_ID}', '${REPOSITORY_ID}', '${commitOid}',
      '${"b".repeat(64)}', '${oid("c")}', '${"d".repeat(64)}', 2, '${USER_ID}')`;
  const generationRow = (index: number, status: "active" | "building" | "ready") =>
    `('${generation(index)}', '${WORKSPACE_ID}', '${REPOSITORY_ID}', '${revision(index)}',
      '${V6_REVISION}', '${status}', 2, '${USER_ID}',
      ${status === "building" ? "NULL" : "now()"}, ${status === "active" ? "now()" : "NULL"})`;
  const payload = (id: string, content: string) =>
    `('${id}', '${WORKSPACE_ID}', '${V6_REVISION}',
      encode(sha256(convert_to('${content}', 'UTF8')), 'hex'), '${content}')`;
  const artifact = (id: string, index: number, path: string, payloadId: string) =>
    `('${id}', '${WORKSPACE_ID}', '${REPOSITORY_ID}', '${revision(index)}', '${generation(index)}',
      '${path}', 'typescript', 'text', 'fallback', 'text', 0, 1, 1, '${payloadId}',
      (SELECT content_sha256 FROM code_artifact_payloads WHERE id = '${payloadId}'))`;
  const jobRow = (
    index: number,
    commitOid: string,
    indexerRevision: string,
    status: "dead" | "pending" | "processing",
  ) =>
    `('${job(index)}', '${WORKSPACE_ID}', '${REPOSITORY_ID}', '/srv/operator/repository',
      '${commitOid}', '${indexerRevision}', '${USER_ID}', '${status}', 2,
      ${status === "processing" ? "gen_random_uuid(), now()" : "NULL, NULL"},
      ${status === "dead" ? "now()" : "NULL"},
      ${status === "dead" ? "'earlier failure'" : "NULL"})`;
  return `
    INSERT INTO users (id, display_name) VALUES ('${USER_ID}', 'Alice');
    INSERT INTO workspaces (id, name) VALUES ('${WORKSPACE_ID}', 'Operations');
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'owner');
    INSERT INTO code_repositories (id, workspace_id, repository_key, display_name, created_by_user_id)
    VALUES ('${REPOSITORY_ID}', '${WORKSPACE_ID}', '${REPOSITORY_KEY}', 'Upgrade cleanup', '${USER_ID}');
    INSERT INTO code_revisions (
      id, workspace_id, repository_id, commit_oid, source_digest, tree_oid, tree_digest,
      file_count, discovered_by_user_id
    ) VALUES
      ${revisionRow(1, bomCommitOid)},
      ${revisionRow(2, oid("2"))},
      ${revisionRow(3, oid("3"))},
      ${revisionRow(4, oid("4"))},
      ${revisionRow(5, oid("5"))},
      ${revisionRow(6, oid("6"))},
      ${revisionRow(7, oid("7"))},
      ${revisionRow(8, oid("8"))};
    INSERT INTO code_revision_files (
      workspace_id, repository_id, revision_id, path, git_mode, object_type, object_oid,
      byte_size, content_sha256, index_status, exclusion_reason
    ) VALUES
      ${file(1, "src/a.ts", "indexed", false)}, ${file(1, "src/bom-only.ts", "indexed", true)},
      ${file(2, "src/a.ts", "indexed", false)}, ${file(2, "src/bom-only.ts", "indexed", true)},
      ${file(3, "src/a.ts", "indexed", false)}, ${file(3, "src/bom-only.ts", "indexed", true)},
      ${file(4, "src/a.ts", "indexed", false)},
      ${file(5, "src/a.ts", "indexed", false)}, ${file(5, "src/bom-only.ts", "indexed", true)},
      ${file(6, "src/a.ts", "indexed", false)}, ${file(6, "src/bom-only.ts", "indexed", true)},
      ${file(7, "src/a.ts", "indexed", false)}, ${file(7, "src/bom-only.ts", "indexed", true)},
      ${file(8, "src/a.ts", "indexed", false)}, ${file(8, "src/bom-only.ts", "excluded", true)};
    INSERT INTO code_index_generations (
      id, workspace_id, repository_id, revision_id, indexer_revision, status,
      artifact_count, indexed_by_user_id, ready_at, activated_at
    ) VALUES
      ${generationRow(1, "building")},
      ${generationRow(3, "active")},
      ${generationRow(4, "building")},
      ${generationRow(7, "ready")};
    INSERT INTO code_artifact_payloads (id, workspace_id, indexer_revision, content_sha256, content)
    VALUES
      ${payload("70000000-0000-4000-8000-000000000001", "export const shared = 1;")},
      ${payload("70000000-0000-4000-8000-000000000002", "export const own = 1;")};
    INSERT INTO code_artifacts (
      id, workspace_id, repository_id, revision_id, generation_id, path, language, parser,
      parse_status, kind, ordinal, start_line, end_line, payload_id, content_sha256
    ) VALUES
      ${artifact("80000000-0000-4000-8000-000000000001", 1, "src/a.ts", "70000000-0000-4000-8000-000000000001")},
      ${artifact("80000000-0000-4000-8000-000000000002", 1, "src/b.ts", "70000000-0000-4000-8000-000000000002")},
      ${artifact("80000000-0000-4000-8000-000000000004", 4, "src/a.ts", "70000000-0000-4000-8000-000000000001")};
    INSERT INTO memories (id, workspace_id, owner_user_id, content)
    VALUES ('90000000-0000-4000-8000-000000000001', '${WORKSPACE_ID}', '${USER_ID}', 'Cites old code.');
    INSERT INTO memory_code_evidence (
      id, workspace_id, memory_id, repository_id, cited_revision_id, cited_generation_id,
      cited_artifact_id, cited_commit_oid, relationship, cited_path, cited_content_sha256,
      validation_state, validated_revision_id, validated_generation_id, validated_commit_oid,
      created_by_user_id
    ) VALUES
      ('91000000-0000-4000-8000-000000000002', '${WORKSPACE_ID}', '90000000-0000-4000-8000-000000000001',
       '${REPOSITORY_ID}', '${revision(2)}', gen_random_uuid(), gen_random_uuid(), '${oid("2")}',
       'rationale', 'src/a.ts', '${"a".repeat(64)}', 'unverifiable', NULL, NULL, NULL, '${USER_ID}'),
      ('91000000-0000-4000-8000-000000000006', '${WORKSPACE_ID}', '90000000-0000-4000-8000-000000000001',
       '${REPOSITORY_ID}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${oid("9")}',
       'supports', 'src/a.ts', '${"a".repeat(64)}', 'deleted', '${revision(6)}', gen_random_uuid(),
       '${oid("6")}', '${USER_ID}');
    INSERT INTO memory_proposals (
      id, workspace_id, owner_user_id, proposed_by_actor_kind, kind, proposed_content,
      proposed_scope, changes_content, changes_scope, changes_metadata
    ) VALUES ('92000000-0000-4000-8000-000000000001', '${WORKSPACE_ID}', '${USER_ID}', 'human',
      'create', 'Proposes from old code.', 'shared', true, true, true);
    INSERT INTO memory_proposal_code_evidence (
      workspace_id, proposal_id, ordinal, repository_id, cited_revision_id, cited_generation_id,
      cited_artifact_id, cited_commit_oid, relationship, cited_path, cited_content_sha256
    ) VALUES ('${WORKSPACE_ID}', '92000000-0000-4000-8000-000000000001', 0, '${REPOSITORY_ID}',
      '${revision(5)}', gen_random_uuid(), gen_random_uuid(), '${oid("5")}', 'rationale',
      'src/a.ts', '${"a".repeat(64)}');
    INSERT INTO code_index_jobs (
      id, workspace_id, repository_id, repository_path, commit_oid, indexer_revision,
      requested_by_user_id, status, attempt_count, lease_token, leased_at, completed_at, last_error
    ) VALUES
      ${jobRow(1, oid("a"), V6_REVISION, "pending")},
      ${jobRow(2, oid("b"), V6_REVISION, "processing")},
      ${jobRow(3, oid("c"), V7_REVISION, "pending")},
      ${jobRow(4, oid("d"), V6_REVISION, "dead")},
      ${jobRow(5, oid("f"), V7_REVISION, "processing")};
  `;
}

test("upgrading to 0004 cancels superseded jobs and removes never-activated BOM-only revisions", async () => {
  const { repositoryPath, commitOid } = await bomRepository();
  const postgres = new PGlite({ extensions: { pg_trgm, vector } });
  onTestFinished(() => postgres.close());
  await postgres.waitReady;
  await applyMigrations(postgres, (number) => number <= 3);
  await postgres.exec(seedSql(commitOid));
  await applyMigrations(postgres, (number) => number > 3);

  // Unfinished jobs of another indexer revision are cancelled; everything else is untouched.
  const jobs = await postgres.query<{
    id: string;
    status: string;
    lease_token: string | null;
    leased_at: Date | null;
    completed_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT id, status::text, lease_token, leased_at, completed_at, last_error
     FROM code_index_jobs ORDER BY id`,
  );
  expect(jobs.rows).toEqual([
    {
      id: job(1),
      status: "cancelled",
      lease_token: null,
      leased_at: null,
      completed_at: expect.any(Date),
      last_error: "Superseded by a newer Code Index revision",
    },
    {
      id: job(2),
      status: "cancelled",
      lease_token: null,
      leased_at: null,
      completed_at: expect.any(Date),
      last_error: "Superseded by a newer Code Index revision",
    },
    expect.objectContaining({ id: job(3), status: "pending", last_error: null }),
    expect.objectContaining({ id: job(4), status: "dead", last_error: "earlier failure" }),
    expect.objectContaining({ id: job(5), status: "processing", lease_token: expect.any(String) }),
  ]);

  // Only revision 1 qualified. Revision 2 is cited by Memory Code Evidence, 3 has an active
  // generation, 4 has no BOM-only entry, 5 is cited by a Proposal, 6 is a validation target,
  // 7 has a ready generation, and 8 already excludes its BOM-only blob.
  const count = async (table: string, column = "revision_id") =>
    (
      await postgres.query<{ revision: string }>(
        `SELECT DISTINCT ${column}::text AS revision FROM ${table} ORDER BY 1`,
      )
    ).rows.map((row) => row.revision);
  const kept = [2, 3, 4, 5, 6, 7, 8].map(revision);
  await expect(count("code_revisions", "id")).resolves.toEqual(kept);
  await expect(count("code_revision_files")).resolves.toEqual(kept);
  await expect(count("code_index_generations")).resolves.toEqual([3, 4, 7].map(revision));
  await expect(count("code_artifacts")).resolves.toEqual([revision(4)]);
  // The cascade's Artifact trigger pruned the payload only revision 1 used.
  await expect(count("code_artifact_payloads", "id")).resolves.toEqual([
    "70000000-0000-4000-8000-000000000001",
  ]);
  // Every Code Evidence anchor survives.
  await expect(
    postgres.query(
      "SELECT 1 FROM memory_code_evidence UNION ALL SELECT 1 FROM memory_proposal_code_evidence",
    ),
  ).resolves.toMatchObject({ rows: [{}, {}, {}] });

  // Indexing the BOM-only commit now records it afresh instead of conflicting with the
  // revision written before v7.
  const repositories: ConfiguredCodeRepositories = {
    [REPOSITORY_KEY]: {
      displayName: "Upgrade cleanup",
      repositoryPath,
      workspaceIds: [WORKSPACE_ID],
    },
  };
  const application = databaseForRole(postgres, "lore_app");
  const queued = await createCodeIndexQueueModule(application, repositories).enqueue(ALICE, {
    repositoryKey: REPOSITORY_KEY,
    commitOid,
  });
  await expect(
    createCodeIndexMaintenanceModule(databaseForRole(postgres, "lore_maintenance"), {
      repositories,
    }).run(queued.id),
  ).resolves.toMatchObject({ status: "complete", jobId: queued.id });
  const code = createCodeIndexModule(application);
  await expect(
    code.getGitRevisionManifest(ALICE, { repositoryKey: REPOSITORY_KEY, commitOid }),
  ).resolves.toMatchObject({
    entries: [
      { path: "src/a.ts", status: "indexed" },
      { path: "src/bom-only.ts", status: "excluded", exclusionReason: "empty" },
    ],
  });
  await expect(
    code.search(ALICE, { repositoryKey: REPOSITORY_KEY, commitOid, query: "upgradeMarker" }),
  ).resolves.toMatchObject([{ path: "src/a.ts" }]);
}, 90_000);
