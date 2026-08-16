import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import { installActorContext } from "@/lib/actor-context";
import { createCodeDependencyGraphModule } from "@/lib/code-graph";
import {
  CODE_INDEX_LIMITS,
  CODE_INDEX_REVISION,
  CodeIndexAccessDeniedError,
  CodeIndexValidationError,
  CodeRevisionConflictError,
  createCodeIndexMaintenanceModule,
  createCodeIndexModule,
} from "@/lib/code-index";
import type { PostgresDatabase } from "@/lib/db";
import { createMemoryTestContext } from "./support/memory-context";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const execFileAsync = promisify(execFile);

async function temporaryGitRepository(objectFormat: "sha1" | "sha256" = "sha1") {
  const repositoryPath = await mkdtemp(join(tmpdir(), "lore-code-index-git-"));
  onTestFinished(async () => {
    await rm(repositoryPath, { force: true, recursive: true });
  });
  await execFileAsync("git", [
    "init",
    "--quiet",
    `--object-format=${objectFormat}`,
    repositoryPath,
  ]);
  return repositoryPath;
}

async function writeRepositoryFile(
  repositoryPath: string,
  path: string,
  content: string | Uint8Array,
) {
  const absolutePath = join(repositoryPath, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function commitGitRepository(repositoryPath: string, addAll = true) {
  if (addAll) await execFileAsync("git", ["-C", repositoryPath, "add", "--all"]);
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
  return stdout.trim();
}

test("indexes the exact committed Git tree instead of dirty working-tree bytes", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const sourcePath = "index.ts";
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    sourcePath,
    'export const revisionMarker = "committed-marker";\n',
  );
  const commitOid = await commitGitRepository(repositoryPath);
  await writeFile(
    join(repositoryPath, sourcePath),
    'export const revisionMarker = "dirty-marker";\n',
    "utf8",
  );

  await code.indexGitRevision(context.alice, {
    repositoryKey: "corespeed/trusted-git",
    displayName: "Trusted Git",
    repositoryPath,
    commitOid,
  });

  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/trusted-git",
      commitOid,
      query: "committed-marker",
    }),
  ).resolves.toMatchObject([{ path: sourcePath }]);
  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/trusted-git",
      commitOid,
      query: "dirty-marker",
    }),
  ).resolves.toEqual([]);
  await expect(
    code.indexRevision(context.alice, {
      repositoryKey: "corespeed/trusted-git",
      displayName: "Trusted Git",
      commitOid,
      files: [{ path: sourcePath, content: 'export const revisionMarker = "committed-marker";\n' }],
    }),
  ).rejects.toBeInstanceOf(CodeRevisionConflictError);
});

test("rejects a well-formed Git OID that does not exist in the repository", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(repositoryPath, "index.ts", "export const value = 1;\n");
  await commitGitRepository(repositoryPath);

  await expect(
    code.indexGitRevision(context.alice, {
      repositoryKey: "corespeed/missing-commit",
      displayName: "Missing commit",
      repositoryPath,
      commitOid: "f".repeat(40),
    }),
  ).rejects.toBeInstanceOf(CodeIndexValidationError);
});

test("queues an exact Git revision without publishing partial search results", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/queued.ts",
    'export const queuedMarker = "not-published-yet";\n',
  );
  const commitOid = await commitGitRepository(repositoryPath);

  const queued = await code.enqueueGitRevision(context.alice, {
    repositoryKey: "corespeed/queued-index",
    displayName: "Queued Index",
    repositoryPath,
    commitOid,
  });

  expect(queued).toMatchObject({
    repositoryKey: "corespeed/queued-index",
    commitOid,
    indexerRevision: CODE_INDEX_REVISION,
    status: "pending",
    attemptCount: 0,
  });
  await expect(code.getIndexJob(context.alice, { jobId: queued.id })).resolves.toEqual(queued);
  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/queued-index",
      commitOid,
      query: "queuedMarker",
    }),
  ).resolves.toEqual([]);

  await context.suspendMembership(context.alice);
  await expect(code.getIndexJob(context.alice, { jobId: queued.id })).rejects.toBeInstanceOf(
    CodeIndexAccessDeniedError,
  );
  await expect(
    createCodeIndexMaintenanceModule(context.maintenanceDatabase).run(queued.id),
  ).resolves.toEqual({ status: "idle" });
});

test("a leased maintenance job publishes one queued exact Git revision", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const maintenance = createCodeIndexMaintenanceModule(context.maintenanceDatabase);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/maintenance.ts",
    'export const maintenanceMarker = "published-by-lease";\n',
  );
  const commitOid = await commitGitRepository(repositoryPath);
  const queued = await code.enqueueGitRevision(context.alice, {
    repositoryKey: "corespeed/maintenance-index",
    displayName: "Maintenance Index",
    repositoryPath,
    commitOid,
  });

  await expect(maintenance.run(queued.id)).resolves.toMatchObject({
    status: "complete",
    jobId: queued.id,
  });
  await expect(code.getIndexJob(context.alice, { jobId: queued.id })).resolves.toMatchObject({
    status: "succeeded",
    attemptCount: 1,
  });
  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/maintenance-index",
      commitOid,
      query: "maintenanceMarker",
    }),
  ).resolves.toMatchObject([
    {
      path: "src/maintenance.ts",
      content: expect.stringContaining("published-by-lease"),
    },
  ]);
});

test("a retried maintenance job resumes from fully persisted Git files", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/first.ts",
    'export const firstCheckpoint = "persisted";\n',
  );
  await writeRepositoryFile(
    repositoryPath,
    "src/second.ts",
    'export const secondCheckpoint = "retried";\n',
  );
  const commitOid = await commitGitRepository(repositoryPath);
  const queued = await code.enqueueGitRevision(context.alice, {
    repositoryKey: "corespeed/resumable-index",
    displayName: "Resumable Index",
    repositoryPath,
    commitOid,
  });
  let artifactInsertCount = 0;
  const interruptedDatabase: PostgresDatabase = {
    transaction: (use) =>
      context.maintenanceDatabase.transaction((transaction) =>
        use({
          query: (sql, params) => {
            if (sql.includes("INSERT INTO code_artifacts")) {
              artifactInsertCount += 1;
              if (artifactInsertCount === 2) throw new Error("simulated worker interruption");
            }
            return transaction.query(sql, params);
          },
        }),
      ),
  };
  const interrupted = createCodeIndexMaintenanceModule(interruptedDatabase);
  await expect(interrupted.run(queued.id)).resolves.toMatchObject({
    status: "retry",
    jobId: queued.id,
  });
  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/resumable-index",
      commitOid,
      query: "firstCheckpoint",
    }),
  ).resolves.toEqual([]);
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query("UPDATE code_index_jobs SET available_at = now() WHERE id = $1", [
      queued.id,
    ]);
  });

  const resumed = createCodeIndexMaintenanceModule(context.maintenanceDatabase);
  await expect(resumed.run(queued.id)).resolves.toMatchObject({
    status: "complete",
    jobId: queued.id,
    parsedFileCount: 1,
    reusedFileCount: 1,
  });
});

test("indexes an exact SHA-256-format Git commit", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository("sha256");
  await writeRepositoryFile(
    repositoryPath,
    "index.ts",
    'export const sha256Marker = "authenticated";\n',
  );
  const commitOid = await commitGitRepository(repositoryPath);
  expect(commitOid).toMatch(/^[0-9a-f]{64}$/);

  await expect(
    code.indexGitRevision(context.alice, {
      repositoryKey: "corespeed/sha256-git",
      displayName: "SHA-256 Git",
      repositoryPath,
      commitOid,
    }),
  ).resolves.toMatchObject({ commitOid, fileCount: 1 });
});

test("rejects Git tree paths it cannot represent without changing them", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(repositoryPath, " leading.ts", "export const value = 1;\n");
  const commitOid = await commitGitRepository(repositoryPath);

  await expect(
    code.indexGitRevision(context.alice, {
      repositoryKey: "corespeed/adversarial-path",
      displayName: "Adversarial path",
      repositoryPath,
      commitOid,
    }),
  ).rejects.toBeInstanceOf(CodeIndexValidationError);
});

test("accounts for every Git tree entry with a typed indexing outcome", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/index.ts",
    'export const treeMarker = "indexed-entry";\n',
  );
  await writeRepositoryFile(
    repositoryPath,
    "dist/generated.js",
    'export const generatedMarker = "tracked-generated-source";\n',
  );
  await writeRepositoryFile(
    repositoryPath,
    "vendor/library.js",
    'export const vendorMarker = "tracked-vendor-source";\n',
  );
  await writeRepositoryFile(repositoryPath, "assets/data.bin", new Uint8Array([0, 1, 2, 3]));
  await writeRepositoryFile(repositoryPath, "assets/invalid-utf8.bin", new Uint8Array([255]));
  await writeRepositoryFile(
    repositoryPath,
    "assets/oversized.txt",
    new Uint8Array(CODE_INDEX_LIMITS.maximumFileBytes + 1).fill(65),
  );
  await writeRepositoryFile(repositoryPath, "empty.txt", "");
  await symlink("../src/index.ts", join(repositoryPath, "linked-index.ts"));
  const referencedCommit = await commitGitRepository(repositoryPath);
  await execFileAsync("git", [
    "-C",
    repositoryPath,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${referencedCommit},vendor/submodule`,
  ]);
  const commitOid = await commitGitRepository(repositoryPath, false);

  const indexed = await code.indexGitRevision(context.alice, {
    repositoryKey: "corespeed/tree-manifest",
    displayName: "Tree manifest",
    repositoryPath,
    commitOid,
  });

  expect(indexed.manifest.entries).toMatchObject([
    { path: "assets/data.bin", status: "excluded", exclusionReason: "binary" },
    {
      path: "assets/invalid-utf8.bin",
      status: "excluded",
      exclusionReason: "invalid_utf8",
    },
    { path: "assets/oversized.txt", status: "excluded", exclusionReason: "oversized" },
    { path: "dist/generated.js", status: "indexed", exclusionReason: null },
    { path: "empty.txt", status: "excluded", exclusionReason: "empty" },
    { path: "linked-index.ts", status: "excluded", exclusionReason: "symlink" },
    { path: "src/index.ts", status: "indexed", exclusionReason: null },
    { path: "vendor/library.js", status: "indexed", exclusionReason: null },
    { path: "vendor/submodule", status: "excluded", exclusionReason: "submodule" },
  ]);
  expect(indexed.manifest).toMatchObject({
    totalEntryCount: 9,
    indexedFileCount: 3,
    excludedFileCount: 6,
  });
  await expect(
    code.getGitRevisionManifest(context.alice, {
      repositoryKey: "corespeed/tree-manifest",
      commitOid,
    }),
  ).resolves.toEqual(indexed.manifest);
  await expect(
    code.getGitRevisionManifest(context.carol, {
      repositoryKey: "corespeed/tree-manifest",
      commitOid,
    }),
  ).rejects.toBeInstanceOf(CodeIndexAccessDeniedError);
  await context.suspendMembership(context.alice);
  await expect(
    code.getGitRevisionManifest(context.alice, {
      repositoryKey: "corespeed/tree-manifest",
      commitOid,
    }),
  ).rejects.toBeInstanceOf(CodeIndexAccessDeniedError);
});

test("reuses unchanged Git blobs across commits and remaps renamed symbol identity", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/stable.ts",
    [
      "export function stableMarker() { return stableTarget(); }",
      "export function stableTarget() { return 'stable'; }",
      "",
    ].join("\n"),
  );
  await writeRepositoryFile(
    repositoryPath,
    "src/changed.ts",
    "export function changedMarker() { return 1; }\n",
  );
  await writeRepositoryFile(
    repositoryPath,
    "src/deleted.ts",
    "export function deletedMarker() { return true; }\n",
  );
  const firstCommit = await commitGitRepository(repositoryPath);
  const first = await code.indexGitRevision(context.alice, {
    repositoryKey: "corespeed/blob-reuse",
    displayName: "Blob reuse",
    repositoryPath,
    commitOid: firstCommit,
  });
  expect(first).toMatchObject({ parsedFileCount: 3, reusedFileCount: 0 });
  const derivationsAfterFirst = await context.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{
      dependency_edges: number;
      dependency_payloads: number;
      dependency_sets: number;
      symbol_payloads: number;
      symbol_sets: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM code_symbol_sets) AS symbol_sets,
         (SELECT count(*)::integer FROM code_symbol_payloads) AS symbol_payloads,
         (SELECT count(*)::integer FROM code_dependency_sets) AS dependency_sets,
         (SELECT count(*)::integer FROM code_dependency_payloads) AS dependency_payloads,
         (SELECT count(*)::integer FROM code_dependency_edges) AS dependency_edges`,
    );
    const counts = result.rows[0];
    if (!counts) throw new Error("Code derivation payload counts were not returned");
    return counts;
  });

  await execFileAsync("git", ["-C", repositoryPath, "mv", "src/stable.ts", "src/renamed.ts"]);
  await chmod(join(repositoryPath, "src/renamed.ts"), 0o755);
  await rm(join(repositoryPath, "src/deleted.ts"));
  await writeRepositoryFile(
    repositoryPath,
    "src/changed.ts",
    "export function changedMarker() { return 2; }\n",
  );
  const secondCommit = await commitGitRepository(repositoryPath);
  const second = await code.indexGitRevision(context.alice, {
    repositoryKey: "corespeed/blob-reuse",
    displayName: "Blob reuse",
    repositoryPath,
    commitOid: secondCommit,
  });
  expect(second).toMatchObject({ parsedFileCount: 1, reusedFileCount: 1 });
  expect(second.manifest.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "src/renamed.ts", mode: "100755", status: "indexed" }),
    ]),
  );
  expect(second.manifest.entries.map((entry) => entry.path)).not.toContain("src/deleted.ts");

  await context.adminDatabase.transaction(async (transaction) => {
    const reusedPayloads = await transaction.query<{
      commit_oid: string;
      ordinal: number;
      payload_id: string;
    }>(
      `SELECT revision.commit_oid, artifact.ordinal, artifact.payload_id
       FROM code_artifacts artifact
       JOIN code_revisions revision ON revision.id = artifact.revision_id
       WHERE (revision.commit_oid = $1 AND artifact.path = 'src/stable.ts')
          OR (revision.commit_oid = $2 AND artifact.path = 'src/renamed.ts')
       ORDER BY revision.commit_oid, artifact.ordinal`,
      [firstCommit, secondCommit],
    );
    const firstPayloadIds = reusedPayloads.rows
      .filter((row) => row.commit_oid === firstCommit)
      .map((row) => row.payload_id);
    const secondPayloadIds = reusedPayloads.rows
      .filter((row) => row.commit_oid === secondCommit)
      .map((row) => row.payload_id);
    expect(firstPayloadIds.length).toBeGreaterThan(0);
    expect(secondPayloadIds).toEqual(firstPayloadIds);

    const counts = await transaction.query<{ artifacts: number; payloads: number }>(
      `SELECT
         (SELECT count(*)::integer FROM code_artifacts) AS artifacts,
         (SELECT count(*)::integer FROM code_artifact_payloads) AS payloads`,
    );
    const count = counts.rows[0];
    expect(count).toBeDefined();
    if (!count) throw new Error("Code Artifact payload counts were not returned");
    expect(count.payloads).toBeLessThan(count.artifacts);

    const derivations = await transaction.query<{
      dependency_edges: number;
      dependency_payloads: number;
      dependency_sets: number;
      symbol_payloads: number;
      symbol_sets: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM code_symbol_sets) AS symbol_sets,
         (SELECT count(*)::integer FROM code_symbol_payloads) AS symbol_payloads,
         (SELECT count(*)::integer FROM code_dependency_sets) AS dependency_sets,
         (SELECT count(*)::integer FROM code_dependency_payloads) AS dependency_payloads,
         (SELECT count(*)::integer FROM code_dependency_edges) AS dependency_edges`,
    );
    expect(derivations.rows[0]).toMatchObject({
      symbol_sets: derivationsAfterFirst.symbol_sets,
      symbol_payloads: derivationsAfterFirst.symbol_payloads,
      dependency_sets: derivationsAfterFirst.dependency_sets,
      dependency_payloads: derivationsAfterFirst.dependency_payloads,
      dependency_edges: expect.any(Number),
    });
    expect(derivations.rows[0]?.dependency_edges).toBeGreaterThan(
      derivationsAfterFirst.dependency_edges,
    );
  });

  const renamed = await code.search(context.alice, {
    repositoryKey: "corespeed/blob-reuse",
    commitOid: secondCommit,
    query: "stableMarker",
  });
  expect(renamed[0]).toMatchObject({
    path: "src/renamed.ts",
    symbol: "stableMarker",
    symbolKey: "src/renamed.ts#function_declaration:stableMarker",
    declarationKey: "src/renamed.ts#function_declaration:stableMarker",
  });
  await expect(
    graph.query(context.alice, {
      repositoryKey: "corespeed/blob-reuse",
      commitOid: secondCommit,
      direction: "callees",
      symbol: "stableMarker",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    edges: [
      {
        kind: "calls",
        from: {
          path: "src/renamed.ts",
          symbolKey: "src/renamed.ts#function_declaration:stableMarker",
        },
        to: {
          path: "src/renamed.ts",
          symbolKey: "src/renamed.ts#function_declaration:stableTarget",
        },
      },
    ],
  });
  const changed = await code.search(context.alice, {
    repositoryKey: "corespeed/blob-reuse",
    commitOid: secondCommit,
    query: "return 2",
  });
  expect(changed[0]?.path).toBe("src/changed.ts");
  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/blob-reuse",
      commitOid: secondCommit,
      query: "deletedMarker",
    }),
  ).resolves.toEqual([]);
});

test("keeps content-addressed Code Artifact payloads isolated by Workspace", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const content = 'export const sharedBytes = "same-content";\n';

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/alice-payloads",
    displayName: "Alice payloads",
    commitOid: COMMIT_A,
    files: [{ path: "src/shared.ts", content }],
  });
  await code.indexRevision(context.carol, {
    repositoryKey: "corespeed/carol-payloads",
    displayName: "Carol payloads",
    commitOid: COMMIT_A,
    files: [{ path: "src/shared.ts", content }],
  });

  await context.adminDatabase.transaction(async (transaction) => {
    const payloads = await transaction.query<{ workspace_id: string; id: string }>(
      `SELECT workspace_id, id
       FROM code_artifact_payloads
       WHERE content_sha256 = encode(sha256(convert_to($1, 'UTF8')), 'hex')
       ORDER BY workspace_id`,
      [content],
    );
    expect(payloads.rows).toHaveLength(2);
    expect(new Set(payloads.rows.map((row) => row.workspace_id)).size).toBe(2);
    expect(new Set(payloads.rows.map((row) => row.id)).size).toBe(2);
  });
});

test("garbage-collects shared derivations only after their last generation membership", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const input = {
    repositoryKey: "corespeed/payload-gc",
    displayName: "Payload GC",
    files: [
      {
        path: "src/exact.ts",
        content: [
          "export function caller() { return target(); }",
          "export function target() { return 'immutable'; }",
          "",
        ].join("\n"),
      },
    ],
  } as const;
  const first = await code.indexRevision(context.alice, { ...input, commitOid: COMMIT_A });
  const second = await code.indexRevision(context.alice, { ...input, commitOid: COMMIT_B });

  await context.adminDatabase.transaction(async (transaction) => {
    const counts = () =>
      transaction.query<{
        artifact_payloads: number;
        dependency_payloads: number;
        dependency_sets: number;
        symbol_payloads: number;
        symbol_sets: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM code_artifact_payloads) AS artifact_payloads,
           (SELECT count(*)::integer FROM code_symbol_sets) AS symbol_sets,
           (SELECT count(*)::integer FROM code_symbol_payloads) AS symbol_payloads,
           (SELECT count(*)::integer FROM code_dependency_sets) AS dependency_sets,
           (SELECT count(*)::integer FROM code_dependency_payloads) AS dependency_payloads`,
      );
    const shared = (await counts()).rows[0];
    expect(shared).toBeDefined();
    expect(shared?.artifact_payloads).toBeGreaterThan(0);
    expect(shared?.symbol_sets).toBeGreaterThan(0);
    expect(shared?.symbol_payloads).toBeGreaterThan(0);
    expect(shared?.dependency_sets).toBeGreaterThan(0);
    expect(shared?.dependency_payloads).toBeGreaterThan(0);
    await transaction.query("DELETE FROM code_index_generations WHERE id = $1", [
      first.generationId,
    ]);
    expect((await counts()).rows[0]).toEqual(shared);
    await transaction.query("DELETE FROM code_index_generations WHERE id = $1", [
      second.generationId,
    ]);
    await expect(counts()).resolves.toMatchObject({
      rows: [
        {
          artifact_payloads: 0,
          symbol_sets: 0,
          symbol_payloads: 0,
          dependency_sets: 0,
          dependency_payloads: 0,
        },
      ],
    });
  });
});

test("does not reuse Git blob artifacts from an incompatible indexer revision", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/protocol.ts",
    "export function protocolMarker() { return true; }\n",
  );
  const firstCommit = await commitGitRepository(repositoryPath);
  await code.indexGitRevision(context.alice, {
    repositoryKey: "corespeed/revision-cache",
    displayName: "Revision cache",
    repositoryPath,
    commitOid: firstCommit,
  });
  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      "UPDATE code_index_generations SET indexer_revision = 'legacy-indexer-revision'",
    );
  });
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
    "--allow-empty",
    "-m",
    "same tree, new commit",
  ]);
  const { stdout } = await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
  const second = await code.indexGitRevision(context.alice, {
    repositoryKey: "corespeed/revision-cache",
    displayName: "Revision cache",
    repositoryPath,
    commitOid: stdout.trim(),
  });
  expect(second).toMatchObject({ parsedFileCount: 1, reusedFileCount: 0 });
});

test("keeps serving the active generation while a replacement is building", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const indexed = await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/rolling-code-index",
    displayName: "Rolling Code Index",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/serving.ts",
        content: 'export const servingMarker = "active-generation";\n',
      },
    ],
  });

  await context.adminDatabase.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE code_index_generations
       SET indexer_revision = 'legacy-serving-revision',
           status = 'active', activated_at = now()
       WHERE id = $1`,
      [indexed.generationId],
    );
    await transaction.query(
      `INSERT INTO code_index_generations (
         id, workspace_id, repository_id, revision_id, indexer_revision,
         status, artifact_count, indexed_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, 'building', 0, $6)`,
      [
        "90000000-0000-4000-8000-000000000001",
        context.alice.workspaceId,
        indexed.repositoryId,
        indexed.revisionId,
        CODE_INDEX_REVISION,
        context.alice.userId,
      ],
    );
  });

  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/rolling-code-index",
      commitOid: COMMIT_A,
      query: "servingMarker",
    }),
  ).resolves.toMatchObject([{ content: expect.stringContaining("active-generation") }]);
});

test("indexes TypeScript by AST symbol while keeping fallback text out of Memory", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const indexed = await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_A,
    sourceRef: "refs/heads/main",
    files: [
      {
        path: "src/memory.ts",
        content: [
          "export function loadMemory(id: string) {",
          "  return { id, kind: 'memory' };",
          "}",
          "",
          "export class MemoryRepository {",
          "  retrieve(id: string) { return loadMemory(id); }",
          "}",
        ].join("\n"),
      },
      {
        path: "docs/architecture.md",
        content: "Canonical Memory is reviewed knowledge. Code artifacts are derived evidence.",
      },
    ],
  });

  expect(indexed).toMatchObject({
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_A,
    fileCount: 2,
    indexerRevision: CODE_INDEX_REVISION,
    reused: false,
  });
  const symbols = await code.search(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_A,
    query: "loadMemory",
  });
  expect(symbols[0]).toMatchObject({
    path: "src/memory.ts",
    language: "typescript",
    parser: "tree_sitter",
    parseStatus: "parsed",
    kind: "function_declaration",
    symbol: "loadMemory",
    symbolKey: "src/memory.ts#function_declaration:loadMemory",
    startLine: 1,
    endLine: 3,
    matchedChannels: expect.arrayContaining(["symbol", "lexical"]),
  });
  expect(symbols[0]?.content).toContain("export function loadMemory");

  const method = await code.search(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_A,
    query: "retrieve",
  });
  expect(method[0]).toMatchObject({
    kind: "method_definition",
    symbol: "MemoryRepository.retrieve",
    symbolKey: "src/memory.ts#method_definition:MemoryRepository.retrieve",
  });

  const fallback = await code.search(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_A,
    query: "reviewed knowledge",
  });
  expect(fallback[0]).toMatchObject({
    path: "docs/architecture.md",
    parser: "text",
    parseStatus: "fallback",
    kind: "text_chunk",
    symbol: null,
  });
  await context.adminDatabase.transaction(async (transaction) => {
    await expect(
      transaction.query("SELECT count(*)::integer AS count FROM memories"),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
  await expect(
    context.database.transaction(async (transaction) => {
      await installActorContext(transaction, context.alice);
      await transaction.query("UPDATE code_artifact_payloads SET content = 'rewritten'");
    }),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    context.adminDatabase.transaction(async (transaction) => {
      await transaction.query("UPDATE code_artifact_payloads SET content = 'rewritten'");
    }),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    context.database.transaction(async (transaction) => {
      await installActorContext(transaction, context.alice);
      await transaction.query("UPDATE code_symbol_payloads SET symbol = 'rewritten'");
    }),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    context.adminDatabase.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO code_dependency_edges (
           id, workspace_id, repository_id, revision_id, generation_id,
           from_artifact_id, dependency_ordinal, resolution,
           to_artifact_id, to_symbol_key
         ) SELECT gen_random_uuid(), workspace_id, repository_id, revision_id,
           generation_id, from_artifact_id, 2147483647, resolution,
           to_artifact_id, to_symbol_key
         FROM code_dependency_edges
         LIMIT 1`,
      );
    }),
  ).rejects.toMatchObject({ code: "23514" });
});

test("keeps symbol identity stable when a declaration moves between revisions", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const functionSource = [
    "export function validateRevision(value: string) {",
    "  return /^[0-9a-f]{40}$/.test(value);",
    "}",
  ].join("\n");
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_A,
    files: [{ path: "src/revision.ts", content: functionSource }],
  });
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_B,
    files: [
      {
        path: "src/revision.ts",
        content: `// The declaration moved down without changing identity.\n\n${functionSource}`,
      },
    ],
  });

  const first = await code.search(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_A,
    query: "validateRevision",
  });
  const second = await code.search(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_B,
    query: "validateRevision",
  });
  expect(first[0]?.symbolKey).toBe("src/revision.ts#function_declaration:validateRevision");
  expect(second[0]?.symbolKey).toBe(first[0]?.symbolKey);
  expect(second[0]?.startLine).toBe(1);
  expect(second[0]?.content).toContain("The declaration moved down");
});

test("splits a large function structurally and preserves its symbol breadcrumb", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const statements = Array.from(
    { length: 400 },
    (_, index) => `  total += input[${index}] ?? ${index};`,
  ).join("\n");
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/large.ts",
        content: `export function aggregateInputs(input: number[]) {\n  let total = 0;\n${statements}\n  return total;\n}`,
      },
    ],
  });

  const results = await code.search(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_A,
    query: "aggregateInputs",
    limit: 100,
  });
  expect(results.length).toBeGreaterThan(1);
  expect(results.length).toBeLessThan(10);
  expect(results.every((result) => result.symbol === "aggregateInputs")).toBe(true);
  expect(
    results.every(
      (result) =>
        result.symbolKey === "src/large.ts#function_declaration:aggregateInputs" &&
        result.declarationKey === "src/large.ts#function_declaration:aggregateInputs",
    ),
  ).toBe(true);
  expect(
    [...results]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((result) => result.declarationChunkOrdinal),
  ).toEqual(results.map((_, index) => index));
  expect(
    results.every((result) => result.content.length <= CODE_INDEX_LIMITS.maximumArtifactCodeUnits),
  ).toBe(true);
});

test("preserves every source character across structural chunk boundaries", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const properties = Array.from(
    { length: 180 },
    (_, index) => `  property${index}: "chunkCoverageMarker";`,
  ).join("\n");
  const source = `export interface LargeShape {\n${properties}\n}`;
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/chunk-coverage",
    displayName: "Chunk coverage",
    commitOid: COMMIT_A,
    files: [{ path: "src/shape.ts", content: source }],
  });

  const chunks = await code.search(context.alice, {
    repositoryKey: "corespeed/chunk-coverage",
    commitOid: COMMIT_A,
    query: "chunkCoverageMarker",
    limit: 100,
  });
  const reconstructed = [...chunks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((chunk) => chunk.content)
    .join("");
  expect(chunks.length).toBeGreaterThan(1);
  expect(reconstructed).toBe(source);
});

test("preserves hard limits, reconstruction, and determinism for an adversarial chunk corpus", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const properties = Array.from(
    { length: 300 },
    (_, index) => `  属性${index}: "汉字😀-${index}";`,
  ).join("\r\n");
  const source = [
    "// 多字节注释 😀 must not shift parser ranges",
    "export interface UnicodeProbe {",
    properties,
    "}",
  ].join("\r\n");
  const boundarySource = `${"x".repeat(CODE_INDEX_LIMITS.maximumArtifactCodeUnits)}\nchunkBoundaryProbe`;
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/unicode-adversarial",
    displayName: "Unicode adversarial",
    commitOid: COMMIT_A,
    files: [
      { path: "fixtures/chunkboundaryprobe.unknown", content: boundarySource },
      { path: "src/unicodeprobe.ts", content: source },
    ],
  });

  const chunks = await code.search(context.alice, {
    repositoryKey: "corespeed/unicode-adversarial",
    commitOid: COMMIT_A,
    query: "unicodeprobe",
    limit: 100,
  });
  const ordered = [...chunks].sort((left, right) => left.ordinal - right.ordinal);
  const hasUnpairedSurrogate = (value: string) =>
    Array.from({ length: value.length }).some((_, index) => {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        return next < 0xdc00 || next > 0xdfff;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        const previous = value.charCodeAt(index - 1);
        return previous < 0xd800 || previous > 0xdbff;
      }
      return false;
    });
  expect(ordered.length).toBeGreaterThan(1);
  expect(ordered.map((chunk) => chunk.ordinal)).toEqual(ordered.map((_, index) => index));
  expect(
    ordered.every(
      (chunk) =>
        chunk.content.length <= CODE_INDEX_LIMITS.maximumArtifactCodeUnits &&
        !hasUnpairedSurrogate(chunk.content),
    ),
  ).toBe(true);
  expect(ordered.map((chunk) => chunk.content).join("")).toBe(source);

  const boundaryChunks = await code.search(context.alice, {
    repositoryKey: "corespeed/unicode-adversarial",
    commitOid: COMMIT_A,
    query: "chunkboundaryprobe",
    limit: 100,
  });
  const orderedBoundary = [...boundaryChunks].sort((left, right) => left.ordinal - right.ordinal);
  expect(orderedBoundary.map((chunk) => chunk.content).join("")).toBe(boundarySource);
  expect(
    orderedBoundary.every(
      (chunk) => chunk.content.length <= CODE_INDEX_LIMITS.maximumArtifactCodeUnits,
    ),
  ).toBe(true);

  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/unicode-adversarial",
    displayName: "Unicode adversarial",
    commitOid: COMMIT_B,
    files: [
      { path: "fixtures/chunkboundaryprobe.unknown", content: boundarySource },
      { path: "src/unicodeprobe.ts", content: source },
    ],
  });
  const replayed = await code.search(context.alice, {
    repositoryKey: "corespeed/unicode-adversarial",
    commitOid: COMMIT_B,
    query: "unicodeprobe",
    limit: 100,
  });
  const stableView = (artifacts: typeof ordered) =>
    [...artifacts]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((artifact) => ({
        contentSha256: artifact.contentSha256,
        declarationChunkOrdinal: artifact.declarationChunkOrdinal,
        declarationKey: artifact.declarationKey,
        endLine: artifact.endLine,
        kind: artifact.kind,
        ordinal: artifact.ordinal,
        path: artifact.path,
        startLine: artifact.startLine,
        symbolKey: artifact.symbolKey,
        symbols: artifact.symbols,
      }));
  expect(stableView(replayed)).toEqual(stableView(ordered));
});

test("indexes every symbol declared by one top-level statement", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/multi-declaration",
    displayName: "Multi declaration",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/constants.ts",
        content: "export const alphaChunkTarget = 1, betaChunkTarget = 2;",
      },
    ],
  });

  const alpha = await code.search(context.alice, {
    repositoryKey: "corespeed/multi-declaration",
    commitOid: COMMIT_A,
    query: "alphaChunkTarget",
  });
  const beta = await code.search(context.alice, {
    repositoryKey: "corespeed/multi-declaration",
    commitOid: COMMIT_A,
    query: "betaChunkTarget",
  });
  expect(alpha[0]).toMatchObject({
    kind: "variable_declarator",
    symbol: "alphaChunkTarget",
    symbolKey: "src/constants.ts#variable_declarator:alphaChunkTarget",
    declarationChunkOrdinal: 0,
  });
  expect(beta[0]).toMatchObject({
    kind: "variable_declarator",
    symbol: "betaChunkTarget",
    symbolKey: "src/constants.ts#variable_declarator:betaChunkTarget",
    declarationChunkOrdinal: 0,
  });
});

test("indexes every symbol declared by one JavaScript var statement", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/multi-var",
    displayName: "Multi var",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/constants.js",
        content: "export var gammaChunkTarget = 3, deltaChunkTarget = 4;",
      },
    ],
  });

  const delta = await code.search(context.alice, {
    repositoryKey: "corespeed/multi-var",
    commitOid: COMMIT_A,
    query: "deltaChunkTarget",
  });
  expect(delta[0]).toMatchObject({
    kind: "variable_declarator",
    symbol: "deltaChunkTarget",
    symbolKey: "src/constants.js#variable_declarator:deltaChunkTarget",
  });
});

test("indexes every binding from one destructuring declaration without duplicating its artifact", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/destructuring",
    displayName: "Destructuring",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/destructuring.ts",
        content: "export const { alphaBinding, sourceName: betaBinding } = loadConfiguration();",
      },
    ],
  });

  const beta = await code.search(context.alice, {
    repositoryKey: "corespeed/destructuring",
    commitOid: COMMIT_A,
    query: "betaBinding",
  });
  expect(beta).toHaveLength(1);
  expect(beta[0]).toMatchObject({
    kind: "variable_declarator",
    symbol: "betaBinding",
    symbolKey: "src/destructuring.ts#variable_declarator:betaBinding",
    symbols: [
      {
        symbol: "alphaBinding",
        symbolKey: "src/destructuring.ts#variable_declarator:alphaBinding",
      },
      {
        symbol: "betaBinding",
        symbolKey: "src/destructuring.ts#variable_declarator:betaBinding",
      },
    ],
  });
});

test("never splits a Unicode code point at a hard fallback boundary", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const source = `unicodeMarker: ${"😀".repeat(3_000)} unicodeMarker ${"😀".repeat(1_500)}`;
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/unicode-fallback",
    displayName: "Unicode fallback",
    commitOid: COMMIT_A,
    files: [{ path: "fixtures/minified.unknown", content: source }],
  });

  const chunks = await code.search(context.alice, {
    repositoryKey: "corespeed/unicode-fallback",
    commitOid: COMMIT_A,
    query: "unicodeMarker",
    limit: 100,
  });
  const hasUnpairedSurrogate = (value: string) =>
    Array.from({ length: value.length }).some((_, index) => {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        return next < 0xdc00 || next > 0xdfff;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        const previous = value.charCodeAt(index - 1);
        return previous < 0xd800 || previous > 0xdbff;
      }
      return false;
    });
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => !hasUnpairedSurrogate(chunk.content))).toBe(true);
  expect(
    [...chunks]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((chunk) => chunk.content)
      .join(""),
  ).toBe(source);
});

test("preserves a whitespace-only fallback chunk needed to reconstruct the source", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const source = `prefix\n${" ".repeat(7_000)}\nsuffix`;
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/whitespace-fallback",
    displayName: "Whitespace fallback",
    commitOid: COMMIT_A,
    files: [{ path: "fixtures/chunk-gap.unknown", content: source }],
  });

  const chunks = await code.search(context.alice, {
    repositoryKey: "corespeed/whitespace-fallback",
    commitOid: COMMIT_A,
    query: "chunk-gap",
    limit: 100,
  });
  expect(chunks.length).toBeGreaterThan(1);
  expect(
    [...chunks]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((chunk) => chunk.content)
      .join(""),
  ).toBe(source);
});

test("falls back safely when syntax errors consume the parsed tree", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/broken.ts",
        content: "export function broken( { return impossibleValue",
      },
    ],
  });

  const results = await code.search(context.alice, {
    repositoryKey: "corespeed/lore",
    commitOid: COMMIT_A,
    query: "impossibleValue",
  });
  expect(results[0]).toMatchObject({
    parser: "text",
    parseStatus: "fallback",
    kind: "text_chunk",
  });
});

test("uses AST parsing across the built-in web languages and marks recovered trees", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/web",
    displayName: "Web",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/Button.tsx",
        content: "export function Button() { return <button>Remember</button>; }",
      },
      {
        path: "src/format.js",
        content: "export function formatMemory(value) { return String(value); }",
      },
      { path: "src/theme.css", content: ".memory { color: rebeccapurple; }" },
      { path: "public/index.html", content: "<main>Code-aware memory</main>" },
      {
        path: "src/recovered.ts",
        content: "export function recoveredSymbol() { return 1; }\nconst broken = ;",
      },
    ],
  });

  for (const [query, expected] of [
    ["Button", { language: "tsx", symbol: "Button", parseStatus: "parsed" }],
    ["formatMemory", { language: "javascript", symbol: "formatMemory", parseStatus: "parsed" }],
    ["rebeccapurple", { language: "css", symbol: null, parseStatus: "parsed" }],
    ["Code-aware", { language: "html", symbol: null, parseStatus: "parsed" }],
    [
      "recoveredSymbol",
      { language: "typescript", symbol: "recoveredSymbol", parseStatus: "recovered" },
    ],
  ] as const) {
    const results = await code.search(context.alice, {
      repositoryKey: "corespeed/web",
      commitOid: COMMIT_A,
      query,
    });
    expect(results[0]).toMatchObject({ parser: "tree_sitter", ...expected });
  }
});

test("preserves punctuation intent ahead of lexical distractors in code search", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/punctuation-search",
    displayName: "Punctuation search",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/a-distractor.ts",
        content: 'export const phrase = "fetch User";',
      },
      {
        path: "src/z-exact.ts",
        content: "export const result = client.fetch<User>(id);",
      },
    ],
  });

  const results = await code.search(context.alice, {
    repositoryKey: "corespeed/punctuation-search",
    commitOid: COMMIT_A,
    query: "fetch<User>",
  });
  expect(results[0]).toMatchObject({
    path: "src/z-exact.ts",
    matchedChannels: ["literal"],
  });
  expect(results[0]?.score).toBeCloseTo(2 / 61, 6);
  expect(results[1]).toMatchObject({
    path: "src/a-distractor.ts",
    matchedChannels: ["lexical"],
  });
  expect(results[1]?.score).toBeCloseTo(1 / 61, 6);
});

test("preserves punctuation-only literal search when no trigram can be extracted", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/punctuation-only-search",
    displayName: "Punctuation-only search",
    commitOid: COMMIT_A,
    files: [
      { path: "src/arrow.ts", content: "export const identity = (value) => value;" },
      { path: "src/plain.ts", content: "export const value = identity(input);" },
    ],
  });

  const results = await code.search(context.alice, {
    repositoryKey: "corespeed/punctuation-only-search",
    commitOid: COMMIT_A,
    query: "=>",
  });
  expect(results.map((result) => result.path)).toEqual(["src/arrow.ts"]);
});

test("treats SQL wildcard characters as exact code-search literals", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/wildcard-search",
    displayName: "Wildcard search",
    commitOid: COMMIT_A,
    files: [
      { path: "src/a-distractor.ts", content: 'export const value = "fetchXUser";' },
      { path: "src/z-exact.ts", content: 'export const value = "fetch%User";' },
    ],
  });

  const results = await code.search(context.alice, {
    repositoryKey: "corespeed/wildcard-search",
    commitOid: COMMIT_A,
    query: "fetch%User",
  });
  expect(results[0]?.path).toBe("src/z-exact.ts");
  expect(results.map((result) => result.path)).not.toContain("src/a-distractor.ts");
});

test("treats an identical revision as idempotent and rejects OID/content conflicts", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const input = {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_A,
    files: [{ path: "src/value.ts", content: "export const value = 1;" }],
  } as const;
  const first = await code.indexRevision(context.alice, input);
  const replay = await code.indexRevision(context.alice, input);
  expect(replay).toMatchObject({
    revisionId: first.revisionId,
    generationId: first.generationId,
    sourceDigest: first.sourceDigest,
    indexerRevision: CODE_INDEX_REVISION,
    reused: true,
  });
  await context.adminDatabase.transaction(async (transaction) => {
    await expect(
      transaction.query(
        `SELECT
           (SELECT count(*)::integer FROM code_revisions) AS revisions,
           (SELECT count(*)::integer FROM code_index_generations) AS generations`,
      ),
    ).resolves.toMatchObject({ rows: [{ revisions: 1, generations: 1 }] });
  });

  await expect(
    code.indexRevision(context.alice, {
      ...input,
      files: [{ path: "src/value.ts", content: "export const value = 2;" }],
    }),
  ).rejects.toBeInstanceOf(CodeRevisionConflictError);
});

test("applies Workspace and revoked-membership isolation before code retrieval", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_A,
    files: [
      { path: "src/private.ts", content: "export const workspaceSecret = 42;" },
      { path: "docs/private.md", content: "workspaceSecret is documented here." },
    ],
  });

  await expect(
    code.search(context.alice, {
      repositoryKey: "corespeed/lore",
      commitOid: COMMIT_A,
      query: "workspaceSecret",
      pathPrefix: "src/",
    }),
  ).resolves.toMatchObject([{ path: "src/private.ts" }]);

  await expect(
    code.search(context.bob, {
      repositoryKey: "corespeed/lore",
      commitOid: COMMIT_A,
      query: "workspaceSecret",
    }),
  ).resolves.toHaveLength(2);
  await expect(
    code.search(context.carol, {
      repositoryKey: "corespeed/lore",
      commitOid: COMMIT_A,
      query: "workspaceSecret",
    }),
  ).resolves.toEqual([]);
  await context.suspendMembership(context.bob);
  await expect(
    code.search(context.bob, {
      repositoryKey: "corespeed/lore",
      commitOid: COMMIT_A,
      query: "workspaceSecret",
    }),
  ).resolves.toEqual([]);
});

test("requires Agent write authority to index but permits read authority to search", async () => {
  const context = await createMemoryTestContext();
  const access = createAccessModule(context.database);
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/lore",
    displayName: "Lore",
    commitOid: COMMIT_A,
    files: [{ path: "src/index.ts", content: "export const indexedFact = true;" }],
  });

  const reader = await access.createAgent(context.alice, { name: "Code Reader" });
  await access.grantAgent(context.alice, reader.id, { permission: "read" });
  const readerCredential = await access.issueAgentCredential(context.alice, reader.id);
  const readerActor = await access.authenticateAgent(
    readerCredential.token,
    context.alice.workspaceId,
  );
  if (!readerActor) throw new Error("Reader Agent authentication failed");

  await expect(
    code.search(readerActor, {
      repositoryKey: "corespeed/lore",
      commitOid: COMMIT_A,
      query: "indexedFact",
    }),
  ).resolves.toHaveLength(1);
  await expect(
    code.indexRevision(readerActor, {
      repositoryKey: "corespeed/lore",
      displayName: "Lore",
      commitOid: COMMIT_B,
      files: [{ path: "src/index.ts", content: "export const indexedFact = false;" }],
    }),
  ).rejects.toBeInstanceOf(CodeIndexAccessDeniedError);
  await access.revokeAgentGrant(context.alice, reader.id);
  await expect(
    code.search(readerActor, {
      repositoryKey: "corespeed/lore",
      commitOid: COMMIT_A,
      query: "indexedFact",
    }),
  ).resolves.toEqual([]);

  const writer = await access.createAgent(context.alice, { name: "Code Writer" });
  await access.grantAgent(context.alice, writer.id, { permission: "write" });
  const writerCredential = await access.issueAgentCredential(context.alice, writer.id);
  const writerActor = await access.authenticateAgent(
    writerCredential.token,
    context.alice.workspaceId,
  );
  if (!writerActor) throw new Error("Writer Agent authentication failed");
  await expect(
    code.indexRevision(writerActor, {
      repositoryKey: "corespeed/lore",
      displayName: "Lore",
      commitOid: COMMIT_C,
      files: [{ path: "src/index.ts", content: "export const indexedFact = 'updated';" }],
    }),
  ).resolves.toMatchObject({ commitOid: COMMIT_C, reused: false });
});

test("rejects traversal paths and abbreviated Git revisions", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await expect(
    code.indexRevision(context.alice, {
      repositoryKey: "corespeed/lore",
      displayName: "Lore",
      commitOid: "abc123",
      files: [],
    }),
  ).rejects.toBeInstanceOf(CodeIndexValidationError);
  await expect(
    code.indexRevision(context.alice, {
      repositoryKey: "corespeed/lore",
      displayName: "Lore",
      commitOid: COMMIT_A,
      files: [{ path: "../secret.ts", content: "export const secret = true;" }],
    }),
  ).rejects.toBeInstanceOf(CodeIndexValidationError);
  await expect(
    code.indexRevision(context.alice, {
      repositoryKey: "corespeed/lore",
      displayName: "Lore",
      commitOid: COMMIT_A,
      files: [{ path: "binary.dat", content: "not\0text" }],
    }),
  ).rejects.toBeInstanceOf(CodeIndexValidationError);
});
