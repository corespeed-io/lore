import type { PostgresDatabase, PostgresTransaction } from "@corespeed/lore-core";
import { isPostgresAccessDenied } from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import {
  CodeIndexAccessDeniedError,
  CodeIndexValidationError,
  CodeRevisionConflictError,
} from "./errors";
import { readGitRevisionFiles, resolveGitCommit, resolveGitTreeOid } from "./git";
import { CODE_INDEX_LIMITS } from "./limits";
import { prepareFile } from "./parser";
import { CODE_INDEX_REVISION } from "./protocol";
import { createCodeIndexReadModule } from "./read";
import type {
  ActiveGitRevisionRow,
  CodeIndexJobRow,
  GenerationRow,
  RepositoryRow,
  RevisionRow,
} from "./storage";
import {
  insertArtifactBatch,
  insertDependencyEdges,
  insertGitManifest,
  loadReusableGitFiles,
  toCodeIndexJob,
} from "./storage";
import type {
  CodeIndexModule,
  IndexCodeRevisionInput,
  IndexedCodeRevision,
  VerifiedGitPreparation,
} from "./types";
import {
  digestFiles,
  digestGitManifest,
  mapConcurrent,
  validateAndSortFiles,
  validateCommitOid,
  validatePlainText,
} from "./validation";

interface CodeIndexMaintenanceLeaseContext {
  jobId: string;
  leaseToken: string;
  repositoryId: string;
}

interface CodeIndexModuleOptions {
  maintenanceLease?: CodeIndexMaintenanceLeaseContext;
}

export function createCodeIndexModule(
  database: PostgresDatabase,
  options: CodeIndexModuleOptions = {},
): CodeIndexModule {
  const reader = createCodeIndexReadModule(database);
  const maintenanceLease = options.maintenanceLease ?? null;
  async function installModuleContext(
    transaction: PostgresTransaction,
    actor: ActorContext,
  ): Promise<void> {
    await installActorContext(transaction, actor);
    if (maintenanceLease) {
      await transaction.query(
        `SELECT
           set_config('lore.code_index_job_id', $1, true),
           set_config('lore.code_index_lease_token', $2, true)`,
        [maintenanceLease.jobId, maintenanceLease.leaseToken],
      );
    }
  }
  const verifiedGitPreparations = new WeakMap<IndexCodeRevisionInput, VerifiedGitPreparation>();

  async function findActiveGitRevision(
    actor: ActorContext,
    repositoryKey: string,
    commitOid: string,
    treeOid: string,
  ): Promise<ActiveGitRevisionRow | null> {
    if (maintenanceLease) return null;
    return database.transaction(async (transaction) => {
      await installModuleContext(transaction, actor);
      const result = await transaction.query<ActiveGitRevisionRow>(
        `SELECT revision.id, revision.repository_id, revision.source_digest,
           revision.tree_oid, revision.tree_digest, revision.file_count,
           generation.id AS generation_id, generation.artifact_count
         FROM code_repositories repository
         JOIN code_revisions revision
           ON revision.workspace_id = repository.workspace_id
          AND revision.repository_id = repository.id
         JOIN code_index_generations generation
           ON generation.workspace_id = revision.workspace_id
          AND generation.repository_id = revision.repository_id
          AND generation.revision_id = revision.id
         WHERE repository.workspace_id = $1
           AND repository.repository_key = $2
           AND revision.commit_oid = $3
           AND revision.tree_oid = $4
           AND revision.tree_digest IS NOT NULL
           AND generation.indexer_revision = $5
           AND generation.status = 'active'`,
        [actor.workspaceId, repositoryKey, commitOid, treeOid, CODE_INDEX_REVISION],
      );
      return result.rows[0] ?? null;
    });
  }

  async function persistGitRevisionResumably(
    actor: ActorContext,
    input: IndexCodeRevisionInput,
    preparation: VerifiedGitPreparation,
  ): Promise<IndexedCodeRevision> {
    if (!maintenanceLease) {
      throw new Error("Resumable Code Index persistence requires a maintenance lease");
    }
    const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
    const commitOid = validateCommitOid(input.commitOid);
    const sourceRef = input.sourceRef ? validatePlainText(input.sourceRef, "sourceRef", 512) : null;
    const files = validateAndSortFiles(input.files);
    const sourceDigest = digestFiles(files);
    const treeDigest = digestGitManifest(preparation.manifest);
    const artifacts = [...preparation.artifacts];
    const dependencies = [...preparation.dependencies];
    if (artifacts.length > CODE_INDEX_LIMITS.maximumArtifacts) {
      throw new CodeIndexValidationError(
        `Revision produced more than ${CODE_INDEX_LIMITS.maximumArtifacts} artifacts`,
      );
    }
    const staged = await database.transaction(async (transaction) => {
      await installModuleContext(transaction, actor);
      const allowed = await transaction.query<{ allowed: boolean }>(
        "SELECT lore.can_maintain_code_index($1, $2) AS allowed",
        [actor.workspaceId, maintenanceLease.repositoryId],
      );
      if (!allowed.rows[0]?.allowed) {
        throw new CodeIndexAccessDeniedError("Maintenance lease cannot index this repository");
      }
      const repository = await transaction.query<RepositoryRow>(
        `SELECT id FROM code_repositories
         WHERE workspace_id = $1 AND id = $2 AND repository_key = $3`,
        [actor.workspaceId, maintenanceLease.repositoryId, repositoryKey],
      );
      const repositoryId = repository.rows[0]?.id;
      if (!repositoryId) {
        throw new CodeIndexAccessDeniedError("Repository is not visible to this maintenance lease");
      }
      const insertedRevision = await transaction.query<RevisionRow>(
        `INSERT INTO code_revisions (
           id, workspace_id, repository_id, commit_oid, source_ref,
           source_digest, tree_oid, tree_digest, file_count,
           discovered_by_user_id, discovered_by_agent_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (repository_id, commit_oid) DO NOTHING
         RETURNING id, source_digest, tree_oid, tree_digest, file_count`,
        [
          crypto.randomUUID(),
          actor.workspaceId,
          repositoryId,
          commitOid,
          sourceRef,
          sourceDigest,
          preparation.treeOid,
          treeDigest,
          files.length,
          actor.userId,
          actor.agentId ?? null,
        ],
      );
      const revisionWasInserted = insertedRevision.rows.length === 1;
      let revision = insertedRevision.rows[0];
      if (!revision) {
        const existing = await transaction.query<RevisionRow>(
          `SELECT id, source_digest, tree_oid, tree_digest, file_count
           FROM code_revisions
           WHERE workspace_id = $1 AND repository_id = $2 AND commit_oid = $3`,
          [actor.workspaceId, repositoryId, commitOid],
        );
        revision = existing.rows[0];
      }
      if (!revision) {
        throw new CodeIndexAccessDeniedError("Revision is not visible to this maintenance lease");
      }
      if (
        revision.source_digest !== sourceDigest ||
        revision.tree_oid !== preparation.treeOid ||
        revision.tree_digest !== treeDigest
      ) {
        throw new CodeRevisionConflictError(
          "The commit OID is already indexed with different source or Git tree evidence",
        );
      }
      if (revisionWasInserted) {
        await insertGitManifest(
          transaction,
          actor,
          repositoryId,
          revision.id,
          preparation.manifest,
        );
      }
      const generationId = crypto.randomUUID();
      const insertedGeneration = await transaction.query<GenerationRow>(
        `INSERT INTO code_index_generations (
           id, workspace_id, repository_id, revision_id, indexer_revision,
           status, artifact_count, indexed_by_user_id, indexed_by_agent_id
         ) VALUES ($1, $2, $3, $4, $5, 'building', $6, $7, $8)
         ON CONFLICT (revision_id, indexer_revision) DO NOTHING
         RETURNING id, artifact_count, status`,
        [
          generationId,
          actor.workspaceId,
          repositoryId,
          revision.id,
          CODE_INDEX_REVISION,
          artifacts.length,
          actor.userId,
          actor.agentId ?? null,
        ],
      );
      let generation = insertedGeneration.rows[0];
      if (!generation) {
        const existing = await transaction.query<GenerationRow>(
          `SELECT id, artifact_count, status
           FROM code_index_generations
           WHERE workspace_id = $1 AND repository_id = $2
             AND revision_id = $3 AND indexer_revision = $4`,
          [actor.workspaceId, repositoryId, revision.id, CODE_INDEX_REVISION],
        );
        generation = existing.rows[0];
      }
      if (!generation) {
        throw new CodeIndexAccessDeniedError(
          "Index generation is not visible to this maintenance lease",
        );
      }
      if (generation.artifact_count !== artifacts.length) {
        throw new CodeRevisionConflictError(
          "The existing Code Index generation expects a different Artifact count",
        );
      }
      if (generation.status === "failed") {
        throw new CodeIndexValidationError("Failed Code Index generation cannot be resumed");
      }
      if (generation.status === "ready" || generation.status === "retiring") {
        await transaction.query("SELECT lore.activate_code_index_generation($1)", [generation.id]);
        generation = { ...generation, status: "active" };
      }
      return { generation, repositoryId, revision };
    });

    if (staged.generation.status !== "active") {
      for (const file of files) {
        const fileArtifacts = artifacts.filter((artifact) => artifact.path === file.path);
        await database.transaction(async (transaction) => {
          await installModuleContext(transaction, actor);
          await insertArtifactBatch(
            transaction,
            actor,
            staged.repositoryId,
            staged.revision.id,
            staged.generation.id,
            fileArtifacts,
            dependencies.filter((dependency) => dependency.path === file.path),
          );
        });
      }
      await database.transaction(async (transaction) => {
        await installModuleContext(transaction, actor);
        await insertDependencyEdges(
          transaction,
          actor,
          staged.repositoryId,
          staged.revision.id,
          staged.generation.id,
          dependencies,
        );
        await transaction.query("SELECT lore.ready_code_index_generation($1)", [
          staged.generation.id,
        ]);
        await transaction.query("SELECT lore.activate_code_index_generation($1)", [
          staged.generation.id,
        ]);
      });
    }
    return {
      revisionId: staged.revision.id,
      generationId: staged.generation.id,
      repositoryId: staged.repositoryId,
      repositoryKey,
      commitOid,
      indexerRevision: CODE_INDEX_REVISION,
      sourceDigest,
      fileCount: staged.revision.file_count,
      artifactCount: artifacts.length,
      reused: staged.generation.status === "active",
    };
  }

  const module: CodeIndexModule = {
    async enqueueGitRevision(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const displayName = validatePlainText(input.displayName, "displayName", 200);
      const commitOid = validateCommitOid(input.commitOid);
      const sourceRef = input.sourceRef
        ? validatePlainText(input.sourceRef, "sourceRef", 512)
        : null;
      const repositoryPath = await resolveGitCommit(input.repositoryPath, commitOid);
      try {
        return await database.transaction(async (transaction) => {
          await installModuleContext(transaction, actor);
          const allowed = await transaction.query<{ allowed: boolean }>(
            "SELECT lore.can_write_code_index($1) AS allowed",
            [actor.workspaceId],
          );
          if (!allowed.rows[0]?.allowed) {
            throw new CodeIndexAccessDeniedError("Actor cannot queue code in this Workspace");
          }
          const insertedRepository = await transaction.query<RepositoryRow>(
            `INSERT INTO code_repositories (
               id, workspace_id, repository_key, display_name,
               created_by_user_id, created_by_agent_id
             ) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (workspace_id, repository_key) DO NOTHING
             RETURNING id`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              repositoryKey,
              displayName,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          let repositoryId = insertedRepository.rows[0]?.id;
          if (!repositoryId) {
            const existingRepository = await transaction.query<RepositoryRow>(
              `SELECT id
               FROM code_repositories
               WHERE workspace_id = $1 AND repository_key = $2`,
              [actor.workspaceId, repositoryKey],
            );
            repositoryId = existingRepository.rows[0]?.id;
          }
          if (!repositoryId) {
            throw new CodeIndexAccessDeniedError("Repository is not visible to this Actor");
          }
          await transaction.query(
            `INSERT INTO code_index_jobs (
               id, workspace_id, repository_id, repository_path, commit_oid,
               source_ref, indexer_revision, requested_by_user_id,
               requested_by_agent_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (repository_id, commit_oid, indexer_revision) DO NOTHING`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              repositoryId,
              repositoryPath,
              commitOid,
              sourceRef,
              CODE_INDEX_REVISION,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          const queued = await transaction.query<CodeIndexJobRow>(
            `SELECT job.id, job.repository_id, repository.repository_key,
               job.commit_oid, job.source_ref, job.indexer_revision, job.status,
               job.attempt_count, job.max_attempts, job.available_at,
               job.completed_at, job.last_error, job.created_at, job.updated_at
             FROM code_index_jobs job
             JOIN code_repositories repository
               ON repository.workspace_id = job.workspace_id
              AND repository.id = job.repository_id
             WHERE job.workspace_id = $1
               AND job.repository_id = $2
               AND job.commit_oid = $3
               AND job.indexer_revision = $4`,
            [actor.workspaceId, repositoryId, commitOid, CODE_INDEX_REVISION],
          );
          const job = queued.rows[0];
          if (!job) throw new CodeIndexAccessDeniedError("Index job is not visible to this Actor");
          return toCodeIndexJob(job);
        });
      } catch (error) {
        if (
          error instanceof CodeIndexAccessDeniedError ||
          error instanceof CodeIndexValidationError
        ) {
          throw error;
        }
        if (isPostgresAccessDenied(error)) {
          throw new CodeIndexAccessDeniedError("Actor cannot queue code in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    getIndexJob: reader.getIndexJob,

    async indexRevision(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const displayName = validatePlainText(input.displayName, "displayName", 200);
      const commitOid = validateCommitOid(input.commitOid);
      const sourceRef = input.sourceRef
        ? validatePlainText(input.sourceRef, "sourceRef", 512)
        : null;
      const files = validateAndSortFiles(input.files);
      const sourceDigest = digestFiles(files);
      const gitPreparation = verifiedGitPreparations.get(input) ?? null;
      const gitManifest = gitPreparation?.manifest ?? null;
      const treeDigest = gitManifest ? digestGitManifest(gitManifest) : null;
      const preparedFiles = gitPreparation
        ? null
        : await mapConcurrent(files, CODE_INDEX_LIMITS.parserConcurrency, prepareFile);
      const artifacts = gitPreparation
        ? [...gitPreparation.artifacts]
        : (preparedFiles ?? []).flatMap((prepared) => prepared.artifacts);
      const dependencies = gitPreparation
        ? [...gitPreparation.dependencies]
        : (preparedFiles ?? []).flatMap((prepared) => prepared.dependencies);
      if (artifacts.length > CODE_INDEX_LIMITS.maximumArtifacts) {
        throw new CodeIndexValidationError(
          `Revision produced more than ${CODE_INDEX_LIMITS.maximumArtifacts} artifacts`,
        );
      }

      try {
        return await database.transaction(async (transaction) => {
          await installModuleContext(transaction, actor);
          const allowed = maintenanceLease
            ? await transaction.query<{ allowed: boolean }>(
                "SELECT lore.can_maintain_code_index($1, $2) AS allowed",
                [actor.workspaceId, maintenanceLease.repositoryId],
              )
            : await transaction.query<{ allowed: boolean }>(
                "SELECT lore.can_write_code_index($1) AS allowed",
                [actor.workspaceId],
              );
          if (!allowed.rows[0]?.allowed) {
            throw new CodeIndexAccessDeniedError("Actor cannot index code in this Workspace");
          }

          const insertedRepository = maintenanceLease
            ? { rows: [] as RepositoryRow[] }
            : await transaction.query<RepositoryRow>(
                `INSERT INTO code_repositories (
                   id, workspace_id, repository_key, display_name,
                   created_by_user_id, created_by_agent_id
                 ) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (workspace_id, repository_key) DO NOTHING
                 RETURNING id`,
                [
                  crypto.randomUUID(),
                  actor.workspaceId,
                  repositoryKey,
                  displayName,
                  actor.userId,
                  actor.agentId ?? null,
                ],
              );
          let repositoryId = insertedRepository.rows[0]?.id;
          if (!repositoryId) {
            const existingRepository = await transaction.query<RepositoryRow>(
              `SELECT id
               FROM code_repositories
               WHERE workspace_id = $1 AND repository_key = $2
                 AND ($3::uuid IS NULL OR id = $3)`,
              [actor.workspaceId, repositoryKey, maintenanceLease?.repositoryId ?? null],
            );
            repositoryId = existingRepository.rows[0]?.id;
          }
          if (!repositoryId) {
            throw new CodeIndexAccessDeniedError("Repository is not visible to this Actor");
          }

          const insertedRevision = await transaction.query<RevisionRow>(
            `INSERT INTO code_revisions (
               id, workspace_id, repository_id, commit_oid, source_ref,
               source_digest, tree_oid, tree_digest, file_count,
               discovered_by_user_id, discovered_by_agent_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (repository_id, commit_oid) DO NOTHING
             RETURNING id, source_digest, tree_oid, tree_digest, file_count`,
            [
              crypto.randomUUID(),
              actor.workspaceId,
              repositoryId,
              commitOid,
              sourceRef,
              sourceDigest,
              gitPreparation?.treeOid ?? null,
              treeDigest,
              files.length,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          const revisionWasInserted = insertedRevision.rows.length === 1;
          let revision = insertedRevision.rows[0];
          if (!revision) {
            const existingRevision = await transaction.query<RevisionRow>(
              `SELECT id, source_digest, tree_oid, tree_digest, file_count
               FROM code_revisions
               WHERE workspace_id = $1
                 AND repository_id = $2
                 AND commit_oid = $3`,
              [actor.workspaceId, repositoryId, commitOid],
            );
            revision = existingRevision.rows[0];
          }
          if (!revision) {
            throw new CodeIndexAccessDeniedError("Revision is not visible to this Actor");
          }
          if (
            revision.source_digest !== sourceDigest ||
            revision.tree_oid !== (gitPreparation?.treeOid ?? null) ||
            revision.tree_digest !== treeDigest
          ) {
            throw new CodeRevisionConflictError(
              "The commit OID is already indexed with different source or Git tree evidence",
            );
          }
          if (revisionWasInserted && gitManifest) {
            await insertGitManifest(transaction, actor, repositoryId, revision.id, gitManifest);
          }

          const generationId = crypto.randomUUID();
          const insertedGeneration = await transaction.query<GenerationRow>(
            `INSERT INTO code_index_generations (
               id, workspace_id, repository_id, revision_id, indexer_revision,
               status, artifact_count, indexed_by_user_id, indexed_by_agent_id,
               ready_at
             ) VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, now())
             ON CONFLICT (revision_id, indexer_revision) DO NOTHING
             RETURNING id, artifact_count, status`,
            [
              generationId,
              actor.workspaceId,
              repositoryId,
              revision.id,
              CODE_INDEX_REVISION,
              artifacts.length,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          const inserted = insertedGeneration.rows[0];
          if (!inserted) {
            const existingGeneration = await transaction.query<GenerationRow>(
              `SELECT id, artifact_count, status
               FROM code_index_generations
               WHERE workspace_id = $1
                 AND repository_id = $2
                 AND revision_id = $3
                 AND indexer_revision = $4`,
              [actor.workspaceId, repositoryId, revision.id, CODE_INDEX_REVISION],
            );
            const generation = existingGeneration.rows[0];
            if (!generation) {
              throw new CodeIndexAccessDeniedError("Index generation is not visible to this Actor");
            }
            if (generation.status !== "active") {
              if (generation.status !== "ready" && generation.status !== "retiring") {
                throw new CodeIndexValidationError(
                  `Index generation cannot be published from ${generation.status}`,
                );
              }
              await transaction.query("SELECT lore.activate_code_index_generation($1)", [
                generation.id,
              ]);
            }
            return {
              revisionId: revision.id,
              generationId: generation.id,
              repositoryId,
              repositoryKey,
              commitOid,
              indexerRevision: CODE_INDEX_REVISION,
              sourceDigest,
              fileCount: revision.file_count,
              artifactCount: generation.artifact_count,
              reused: true,
            };
          }

          await insertArtifactBatch(
            transaction,
            actor,
            repositoryId,
            revision.id,
            generationId,
            artifacts,
            dependencies,
          );
          await insertDependencyEdges(
            transaction,
            actor,
            repositoryId,
            revision.id,
            generationId,
            dependencies,
          );
          await transaction.query("SELECT lore.activate_code_index_generation($1)", [generationId]);
          return {
            revisionId: revision.id,
            generationId,
            repositoryId,
            repositoryKey,
            commitOid,
            indexerRevision: CODE_INDEX_REVISION,
            sourceDigest,
            fileCount: revision.file_count,
            artifactCount: artifacts.length,
            reused: false,
          };
        });
      } catch (error) {
        if (
          error instanceof CodeIndexAccessDeniedError ||
          error instanceof CodeRevisionConflictError ||
          error instanceof CodeIndexValidationError
        ) {
          throw error;
        }
        if (isPostgresAccessDenied(error)) {
          throw new CodeIndexAccessDeniedError("Actor cannot index code in this Workspace", {
            cause: error,
          });
        }
        throw error;
      }
    },

    async indexGitRevision(actor, input) {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const commitOid = validateCommitOid(input.commitOid);
      const canonicalPath = await resolveGitCommit(input.repositoryPath, commitOid);
      const treeOid = await resolveGitTreeOid(canonicalPath, commitOid);
      const active = await findActiveGitRevision(actor, repositoryKey, commitOid, treeOid);
      if (active) {
        const manifest = await reader.getGitRevisionManifest(actor, { repositoryKey, commitOid });
        return {
          revisionId: active.id,
          generationId: active.generation_id,
          repositoryId: active.repository_id,
          repositoryKey,
          commitOid,
          indexerRevision: CODE_INDEX_REVISION,
          sourceDigest: active.source_digest,
          fileCount: active.file_count,
          artifactCount: active.artifact_count,
          reused: true,
          manifest,
          parsedFileCount: 0,
          reusedFileCount: manifest.indexedFileCount,
        };
      }
      const snapshot = await readGitRevisionFiles(canonicalPath, commitOid);
      const reusableByPath = await loadReusableGitFiles(
        database,
        actor,
        snapshot.manifest,
        (transaction) => installModuleContext(transaction, actor),
      );
      const parsedByPath = new Map(
        (
          await mapConcurrent(
            snapshot.files.filter((file) => !reusableByPath.has(file.path)),
            CODE_INDEX_LIMITS.parserConcurrency,
            async (file) => ({ prepared: await prepareFile(file), path: file.path }),
          )
        ).map((prepared) => [prepared.path, prepared.prepared] as const),
      );
      const artifacts = snapshot.files.flatMap(
        (file) =>
          reusableByPath.get(file.path)?.artifacts ?? parsedByPath.get(file.path)?.artifacts ?? [],
      );
      const dependencies = snapshot.files.flatMap(
        (file) =>
          parsedByPath.get(file.path)?.dependencies ??
          reusableByPath.get(file.path)?.dependencies ??
          [],
      );
      const revisionInput: IndexCodeRevisionInput = {
        repositoryKey,
        displayName: input.displayName,
        commitOid,
        sourceRef: input.sourceRef,
        files: snapshot.files,
      };
      const preparation: VerifiedGitPreparation = {
        manifest: snapshot.manifest,
        treeOid,
        artifacts,
        dependencies,
        parsedFileCount: parsedByPath.size,
        reusedFileCount: reusableByPath.size,
      };
      verifiedGitPreparations.set(revisionInput, preparation);
      try {
        const indexed = maintenanceLease
          ? await persistGitRevisionResumably(actor, revisionInput, preparation)
          : await module.indexRevision(actor, revisionInput);
        return {
          ...indexed,
          manifest: snapshot.manifest,
          parsedFileCount: preparation.parsedFileCount,
          reusedFileCount: preparation.reusedFileCount,
        };
      } finally {
        verifiedGitPreparations.delete(revisionInput);
      }
    },

    getGitRevisionManifest: reader.getGitRevisionManifest,

    search: reader.search,
  };
  return module;
}
