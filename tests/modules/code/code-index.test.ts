import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PostgresDatabase } from "@corespeed/lore-core";
import { expect, onTestFinished, test } from "vitest";
import { createCodeDependencyGraphModule } from "@/modules/code/graph";
import {
  CodeIndexAccessDeniedError,
  CodeIndexRetryableError,
  CodeIndexValidationError,
  CodeRevisionConflictError,
} from "@/modules/code/indexing/errors";
import { createCodeIndexMaintenanceModule } from "@/modules/code/indexing/maintenance";
import { prepareFile } from "@/modules/code/indexing/parser";
import { CODE_INDEX_LIMITS, CODE_INDEX_REVISION } from "@/modules/code/indexing/protocol";
import {
  type ConfiguredCodeRepository,
  createCodeIndexQueueModule,
} from "@/modules/code/indexing/queue";
import { createCodeIndexModule } from "@/modules/code/indexing/service";
import type { PreparedArtifact } from "@/modules/code/indexing/types";
import { createAccessModule } from "@/server/auth/access";
import type { ActorContext } from "../../../src/server/auth/actor-context";
import { installActorContext } from "../../../src/server/auth/actor-context";
import { createMemoryTestContext } from "../../support/memory-context";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const execFileAsync = promisify(execFile);

/**
 * The operator registry both the queue and the worker read, as in production. Each
 * test queues its fixture repository before running maintenance, so the latest
 * entry for a key is the one the worker resolves.
 */
const repositories: Record<string, ConfiguredCodeRepository> = {};

/** Queues one exact commit through the operator registry, as the public route does. */
function enqueueConfiguredRevision(
  database: PostgresDatabase,
  actor: ActorContext,
  input: { repositoryKey: string; displayName: string; repositoryPath: string; commitOid: string },
) {
  repositories[input.repositoryKey] = {
    displayName: input.displayName,
    repositoryPath: input.repositoryPath,
  };
  const queue = createCodeIndexQueueModule(database, repositories);
  return queue.enqueue(actor, { repositoryKey: input.repositoryKey, commitOid: input.commitOid });
}

function codeIndexMaintenance(database: PostgresDatabase) {
  return createCodeIndexMaintenanceModule(database, { repositories });
}

/** Wraps a database so that the first statement matching `interrupts` fails like a crash. */
function interruptingDatabase(
  database: PostgresDatabase,
  interrupts: (sql: string, params: unknown[] | undefined) => boolean,
): PostgresDatabase {
  return {
    transaction: (use) =>
      database.transaction((transaction) =>
        use({
          query: (sql, params) => {
            if (interrupts(sql, params)) throw new Error("simulated worker interruption");
            return transaction.query(sql, params);
          },
        }),
      ),
  };
}

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

test("rejects a well-formed Git OID that is not in the repository as retryable", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(repositoryPath, "index.ts", "export const value = 1;\n");
  await commitGitRepository(repositoryPath);

  // The commit may simply not be fetched yet, so a job keeps its retry budget.
  const failure = await code
    .indexGitRevision(context.alice, {
      repositoryKey: "corespeed/missing-commit",
      displayName: "Missing commit",
      repositoryPath,
      commitOid: "f".repeat(40),
    })
    .then(
      () => new Error("Expected indexing to fail"),
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(CodeIndexRetryableError);
  expect(failure).toMatchObject({ message: "Unable to read the requested Git revision" });
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

  const queued = await enqueueConfiguredRevision(context.database, context.alice, {
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
  await expect(codeIndexMaintenance(context.maintenanceDatabase).run(queued.id)).resolves.toEqual({
    status: "idle",
  });
});

test("a leased maintenance job publishes one queued exact Git revision", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const maintenance = codeIndexMaintenance(context.maintenanceDatabase);
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/maintenance.ts",
    'export const maintenanceMarker = "published-by-lease";\n',
  );
  const commitOid = await commitGitRepository(repositoryPath);
  const queued = await enqueueConfiguredRevision(context.database, context.alice, {
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
  // The first file alone fills one checkpoint, so the second file commits separately.
  await writeRepositoryFile(
    repositoryPath,
    "src/first.ts",
    Array.from(
      { length: CODE_INDEX_LIMITS.checkpointArtifacts },
      (_, index) => `export function firstCheckpoint${index}() { return "persisted"; }\n`,
    ).join(""),
  );
  await writeRepositoryFile(
    repositoryPath,
    "src/second.ts",
    'export const secondCheckpoint = "retried";\n',
  );
  const commitOid = await commitGitRepository(repositoryPath);
  const queued = await enqueueConfiguredRevision(context.database, context.alice, {
    repositoryKey: "corespeed/resumable-index",
    displayName: "Resumable Index",
    repositoryPath,
    commitOid,
  });
  const interruptedDatabase = interruptingDatabase(
    context.maintenanceDatabase,
    (sql, params) =>
      sql.includes("INSERT INTO code_artifacts") && Boolean(params?.includes("src/second.ts")),
  );
  const interrupted = codeIndexMaintenance(interruptedDatabase);
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

  const resumed = codeIndexMaintenance(context.maintenanceDatabase);
  await expect(resumed.run(queued.id)).resolves.toMatchObject({
    status: "complete",
    jobId: queued.id,
    parsedFileCount: 1,
    reusedFileCount: 1,
  });
});

test("a leased job commits small complete files together in one bounded checkpoint", async () => {
  const context = await createMemoryTestContext();
  const repositoryPath = await temporaryGitRepository();
  for (const name of ["alpha", "beta", "gamma"]) {
    await writeRepositoryFile(
      repositoryPath,
      `src/${name}.ts`,
      `export function ${name}Checkpoint() { return "${name}"; }\n`,
    );
  }
  const commitOid = await commitGitRepository(repositoryPath);
  const queued = await enqueueConfiguredRevision(context.database, context.alice, {
    repositoryKey: "corespeed/grouped-checkpoints",
    displayName: "Grouped checkpoints",
    repositoryPath,
    commitOid,
  });
  let checkpointTransactions = 0;
  const counted: PostgresDatabase = {
    transaction: (use) =>
      context.maintenanceDatabase.transaction((transaction) => {
        let insertsArtifacts = false;
        return use({
          query: (sql, params) => {
            if (!insertsArtifacts && sql.includes("INSERT INTO code_artifacts")) {
              insertsArtifacts = true;
              checkpointTransactions += 1;
            }
            return transaction.query(sql, params);
          },
        });
      }),
  };

  await expect(codeIndexMaintenance(counted).run(queued.id)).resolves.toMatchObject({
    status: "complete",
    parsedFileCount: 3,
  });
  expect(checkpointTransactions).toBe(1);
});

test("an interrupted job's building generation resumes itself with its dependencies intact", async () => {
  const context = await createMemoryTestContext();
  const graph = createCodeDependencyGraphModule(context.database);
  const repositoryKey = "corespeed/building-resume";
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/calls.ts",
    [
      "export function resumeCaller() { return resumeCallee(); }",
      "export function resumeCallee() { return 'resumed'; }",
      "",
    ].join("\n"),
  );
  const commitOid = await commitGitRepository(repositoryPath);
  const queued = await enqueueConfiguredRevision(context.database, context.alice, {
    repositoryKey,
    displayName: "Building resume",
    repositoryPath,
    commitOid,
  });
  // Every file checkpoint commits; the worker dies before edges, readiness, and activation.
  const crashBeforeReady = interruptingDatabase(context.maintenanceDatabase, (sql) =>
    sql.includes("INSERT INTO code_dependency_edges"),
  );
  await expect(codeIndexMaintenance(crashBeforeReady).run(queued.id)).resolves.toMatchObject({
    status: "retry",
  });
  await context.adminDatabase.transaction(async (transaction) => {
    await expect(
      transaction.query(
        `SELECT generation.status,
           (SELECT count(*)::integer FROM code_artifacts artifact
            WHERE artifact.generation_id = generation.id) AS artifacts,
           (SELECT count(*)::integer FROM code_dependency_edges edge
            WHERE edge.generation_id = generation.id) AS edges
         FROM code_index_generations generation`,
      ),
    ).resolves.toMatchObject({ rows: [{ status: "building", artifacts: 2, edges: 0 }] });
    await transaction.query("UPDATE code_index_jobs SET available_at = now() WHERE id = $1", [
      queued.id,
    ]);
  });

  // The retry reuses its own checkpoints, reading dependencies from their immutable sets.
  await expect(
    codeIndexMaintenance(context.maintenanceDatabase).run(queued.id),
  ).resolves.toMatchObject({ status: "complete", parsedFileCount: 0, reusedFileCount: 1 });
  await expect(
    graph.query(context.alice, {
      repositoryKey,
      commitOid,
      direction: "callees",
      symbol: "resumeCaller",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    edges: [
      {
        kind: "calls",
        resolution: "resolved",
        to: { symbolKey: "src/calls.ts#function_declaration:resumeCallee" },
      },
    ],
  });
});

test("another commit never reuses Artifacts from a building generation", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const graph = createCodeDependencyGraphModule(context.database);
  const repositoryKey = "corespeed/building-donor";
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(
    repositoryPath,
    "src/calls.ts",
    [
      "export function donorCaller() { return donorCallee(); }",
      "export function donorCallee() { return 'donor'; }",
      "",
    ].join("\n"),
  );
  const firstCommit = await commitGitRepository(repositoryPath);
  await writeRepositoryFile(repositoryPath, "src/other.ts", "export const otherMarker = 1;\n");
  const secondCommit = await commitGitRepository(repositoryPath);
  const queued = await enqueueConfiguredRevision(context.database, context.alice, {
    repositoryKey,
    displayName: "Building donor",
    repositoryPath,
    commitOid: firstCommit,
  });
  const crashBeforeReady = interruptingDatabase(context.maintenanceDatabase, (sql) =>
    sql.includes("INSERT INTO code_dependency_edges"),
  );
  await expect(codeIndexMaintenance(crashBeforeReady).run(queued.id)).resolves.toMatchObject({
    status: "retry",
  });

  // The unchanged blob's only prior Artifacts sit in the unready building generation.
  await expect(
    code.indexGitRevision(context.alice, {
      repositoryKey,
      displayName: "Building donor",
      repositoryPath,
      commitOid: secondCommit,
    }),
  ).resolves.toMatchObject({ parsedFileCount: 2, reusedFileCount: 0 });
  await expect(
    graph.query(context.alice, {
      repositoryKey,
      commitOid: secondCommit,
      direction: "callees",
      symbol: "donorCaller",
    }),
  ).resolves.toMatchObject({
    status: "ok",
    edges: [
      {
        kind: "calls",
        resolution: "resolved",
        to: { symbolKey: "src/calls.ts#function_declaration:donorCallee" },
      },
    ],
  });
});

test("whitespace-only, padded, and BOM-bearing Git files index, activate, and reuse exactly", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  const repositoryKey = "corespeed/padded-sources";
  const padded =
    "\n\n  // Leading padding belongs to the first Artifact.\nexport function paddedMarker() {\n  return 1;\n}\n";
  const repositoryPath = await temporaryGitRepository();
  await writeRepositoryFile(repositoryPath, "src/blank.ts", "  \n\t\n");
  await writeRepositoryFile(repositoryPath, "src/bom-only.ts", new Uint8Array([0xef, 0xbb, 0xbf]));
  await writeRepositoryFile(repositoryPath, "src/bom.ts", "﻿export const bomMarker = 1;\n");
  await writeRepositoryFile(repositoryPath, "src/padded.ts", padded);
  const firstCommit = await commitGitRepository(repositoryPath);
  const queued = await enqueueConfiguredRevision(context.database, context.alice, {
    repositoryKey,
    displayName: "Padded sources",
    repositoryPath,
    commitOid: firstCommit,
  });

  await expect(
    codeIndexMaintenance(context.maintenanceDatabase).run(queued.id),
  ).resolves.toMatchObject({ status: "complete", parsedFileCount: 3, reusedFileCount: 0 });
  const manifest = await code.getGitRevisionManifest(context.alice, {
    repositoryKey,
    commitOid: firstCommit,
  });
  expect(manifest.entries).toMatchObject([
    { path: "src/blank.ts", status: "indexed", exclusionReason: null },
    { path: "src/bom-only.ts", status: "excluded", exclusionReason: "empty" },
    { path: "src/bom.ts", status: "indexed", exclusionReason: null },
    { path: "src/padded.ts", status: "indexed", exclusionReason: null },
  ]);
  await expect(
    code.search(context.alice, { repositoryKey, commitOid: firstCommit, query: "paddedMarker" }),
  ).resolves.toMatchObject([{ path: "src/padded.ts", ordinal: 0, content: padded }]);

  // Reuse requires exact reconstruction, so every unchanged indexed file must qualify.
  await writeRepositoryFile(repositoryPath, "src/changed.ts", "export const changedMarker = 1;\n");
  const secondCommit = await commitGitRepository(repositoryPath);
  await expect(
    code.indexGitRevision(context.alice, {
      repositoryKey,
      displayName: "Padded sources",
      repositoryPath,
      commitOid: secondCommit,
    }),
  ).resolves.toMatchObject({ parsedFileCount: 1, reusedFileCount: 3 });
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

function expectExactCodePartition(content: string, artifacts: readonly PreparedArtifact[]) {
  expect(artifacts.map((artifact) => artifact.content).join("")).toBe(content);
  expect(artifacts.map((artifact) => artifact.ordinal)).toEqual(artifacts.map((_, index) => index));
  for (const artifact of artifacts) {
    expect(artifact.content.length).toBeLessThanOrEqual(CODE_INDEX_LIMITS.maximumArtifactCodeUnits);
    expect(artifact.content).not.toMatch(/[\uD800-\uDFFF]/u);
  }
}

test("splits a large function structurally and preserves its symbol breadcrumb", async () => {
  const statements = Array.from(
    { length: 400 },
    (_, index) => `  total += input[${index}] ?? ${index};`,
  ).join("\n");
  const content = `export function aggregateInputs(input: number[]) {\n  let total = 0;\n${statements}\n  return total;\n}`;
  const { artifacts } = await prepareFile({ path: "src/large.ts", content });

  expect(artifacts.length).toBeGreaterThan(1);
  expect(artifacts.length).toBeLessThan(10);
  expect(artifacts.every((artifact) => artifact.symbol === "aggregateInputs")).toBe(true);
  expect(
    artifacts.every(
      (artifact) =>
        artifact.symbolKey === "src/large.ts#function_declaration:aggregateInputs" &&
        artifact.declarationKey === "src/large.ts#function_declaration:aggregateInputs",
    ),
  ).toBe(true);
  expect(artifacts.map((artifact) => artifact.declarationChunkOrdinal)).toEqual(
    artifacts.map((_, index) => index),
  );
  expectExactCodePartition(content, artifacts);
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
  for (const file of [
    { path: "src/unicodeprobe.ts", content: source },
    {
      path: "fixtures/chunkboundaryprobe.unknown",
      content: `${"x".repeat(CODE_INDEX_LIMITS.maximumArtifactCodeUnits)}\nchunkBoundaryProbe`,
    },
  ]) {
    const prepared = await prepareFile(file);
    expect(prepared.artifacts.length).toBeGreaterThan(1);
    expectExactCodePartition(file.content, prepared.artifacts);
    expect(await prepareFile(file)).toEqual(prepared);
  }
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

test("parses every symbol declared by one JavaScript var statement", async () => {
  const { artifacts } = await prepareFile({
    path: "src/constants.js",
    content: "export var gammaChunkTarget = 3, deltaChunkTarget = 4;",
  });

  expect(artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "variable_declarator",
        symbol: "deltaChunkTarget",
        symbolKey: "src/constants.js#variable_declarator:deltaChunkTarget",
      }),
    ]),
  );
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
  const content = `unicodeMarker: ${"😀".repeat(3_000)} unicodeMarker ${"😀".repeat(1_500)}`;
  const { artifacts } = await prepareFile({ path: "fixtures/minified.unknown", content });

  expect(artifacts.length).toBeGreaterThan(1);
  expectExactCodePartition(content, artifacts);
});

test("preserves a whitespace-only fallback chunk needed to reconstruct the source", async () => {
  const content = `prefix\n${" ".repeat(7_000)}\nsuffix`;
  const { artifacts } = await prepareFile({ path: "fixtures/chunk-gap.unknown", content });

  expect(artifacts.length).toBeGreaterThan(1);
  expectExactCodePartition(content, artifacts);
});

test("partitions leading padding, a BOM, and whitespace-only files exactly in every built-in language", async () => {
  const whitespaceOnly = "  \n\t\r\n";
  for (const path of [
    "src/blank.ts",
    "src/blank.tsx",
    "src/blank.js",
    "src/blank.jsx",
    "src/blank.css",
    "public/blank.html",
  ]) {
    const { artifacts } = await prepareFile({ path, content: whitespaceOnly });
    expect(artifacts, path).toMatchObject([
      { parser: "tree_sitter", parseStatus: "parsed", symbol: null, startLine: 1 },
    ]);
    expectExactCodePartition(whitespaceOnly, artifacts);
  }
  for (const file of [
    { path: "src/leading-blank.ts", content: "\n\n\nexport const leadingBlank = 1;\n" },
    {
      path: "src/leading-comment.ts",
      content: "   // Indented first comment.\nexport function commented() { return 1; }\n",
    },
    { path: "src/bom.ts", content: "﻿export const bomPrefixed = 1;\n" },
    { path: "src/bom-only.ts", content: "﻿" },
    { path: "src/leading.css", content: "\n\n.memory { color: rebeccapurple; }\n" },
    { path: "public/leading.html", content: "\n  <main>Code-aware memory</main>\n" },
  ]) {
    const { artifacts } = await prepareFile(file);
    expect(artifacts.length, file.path).toBeGreaterThan(0);
    expect(artifacts[0]?.startIndex, file.path).toBe(0);
    expectExactCodePartition(file.content, artifacts);
  }
  const { artifacts: commented } = await prepareFile({
    path: "src/leading-comment.ts",
    content: "   // Indented first comment.\nexport function commented() { return 1; }\n",
  });
  expect(commented).toMatchObject([
    {
      symbol: "commented",
      declarationChunkOrdinal: 0,
      content: expect.stringMatching(/^ {3}\/\//),
    },
  ]);
});

test("an import block never claims the file's only declaration", async () => {
  const content = [
    "import alpha from './alpha';",
    "import beta from './beta';",
    "export default function Button() { return alpha(beta); }",
    "",
  ].join("\n");
  const { artifacts, dependencies } = await prepareFile({ path: "src/Button.ts", content });

  expect(artifacts).toMatchObject([
    {
      kind: "import_statement",
      symbol: null,
      symbolKey: null,
      declarationKey: null,
      declarationChunkOrdinal: null,
      symbols: [],
    },
    {
      kind: "function_declaration",
      symbol: "Button",
      declarationKey: "src/Button.ts#function_declaration:Button",
      declarationChunkOrdinal: 0,
    },
  ]);
  expectExactCodePartition(content, artifacts);
  expect(dependencies.filter((dependency) => dependency.kind === "imports")).toMatchObject([
    { fromArtifactOrdinal: 0, fromSymbolKey: null, targetText: "./alpha" },
    { fromArtifactOrdinal: 0, fromSymbolKey: null, targetText: "./beta" },
  ]);
});

test("falls back safely when syntax errors consume the parsed tree", async () => {
  const { artifacts } = await prepareFile({
    path: "src/broken.ts",
    content: "export function broken( { return impossibleValue",
  });

  expect(artifacts[0]).toMatchObject({
    parser: "text",
    parseStatus: "fallback",
    kind: "text_chunk",
  });
});

test("uses AST parsing across the built-in web languages and marks recovered trees", async () => {
  for (const [file, expected] of [
    [
      {
        path: "src/Button.tsx",
        content: "export function Button() { return <button>Remember</button>; }",
      },
      { language: "tsx", symbol: "Button", parseStatus: "parsed" },
    ],
    [
      {
        path: "src/format.js",
        content: "export function formatMemory(value) { return String(value); }",
      },
      { language: "javascript", symbol: "formatMemory", parseStatus: "parsed" },
    ],
    [
      { path: "src/theme.css", content: ".memory { color: rebeccapurple; }" },
      { language: "css", symbol: null, parseStatus: "parsed" },
    ],
    [
      { path: "public/index.html", content: "<main>Code-aware memory</main>" },
      { language: "html", symbol: null, parseStatus: "parsed" },
    ],
    [
      {
        path: "src/recovered.ts",
        content: "export function recoveredSymbol() { return 1; }\nconst broken = ;",
      },
      { language: "typescript", symbol: "recoveredSymbol", parseStatus: "recovered" },
    ],
  ] as const) {
    const { artifacts } = await prepareFile(file);
    expect(artifacts, file.path).toEqual(
      expect.arrayContaining([expect.objectContaining({ parser: "tree_sitter", ...expected })]),
    );
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

test("searches multi-line code queries while rejecting other control characters", async () => {
  const context = await createMemoryTestContext();
  const code = createCodeIndexModule(context.database);
  await code.indexRevision(context.alice, {
    repositoryKey: "corespeed/multi-line-search",
    displayName: "Multi-line search",
    commitOid: COMMIT_A,
    files: [
      {
        path: "src/guard.ts",
        content: "export function multiLineGuard() {\n\treturn true;\r\n}\n",
      },
      { path: "src/other.ts", content: "export function multiLineGuard2() { return false; }\n" },
    ],
  });

  const results = await code.search(context.alice, {
    repositoryKey: "corespeed/multi-line-search",
    commitOid: COMMIT_A,
    query: "multiLineGuard() {\n\treturn true;\r\n}",
  });
  expect(results[0]).toMatchObject({
    path: "src/guard.ts",
    matchedChannels: expect.arrayContaining(["literal"]),
  });
  for (const query of ["multiLineGuard\0", "multiLine\u000bGuard", "multiLine\u001bGuard"]) {
    await expect(
      code.search(context.alice, {
        repositoryKey: "corespeed/multi-line-search",
        commitOid: COMMIT_A,
        query,
      }),
    ).rejects.toBeInstanceOf(CodeIndexValidationError);
  }
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
