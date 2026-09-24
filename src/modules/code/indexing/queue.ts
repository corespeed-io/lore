import type { PostgresDatabase } from "@corespeed/lore-core";
import { isPostgresAccessDenied } from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";
import { installActorContext } from "@/server/auth/actor-context";
import { CodeIndexAccessDeniedError, CodeIndexValidationError } from "./errors";
import { CODE_INDEX_REVISION } from "./protocol";
import type { CodeIndexJob, CodeIndexJobStatus } from "./types";
import { validateCommitOid, validatePlainText } from "./validation";

export interface ConfiguredCodeRepository {
  displayName: string;
  repositoryPath: string;
  /**
   * Workspaces whose Actors may enqueue and index this repository. An entry
   * without this binding serves every Workspace, so
   * configuredCodeRepositoriesFromEnvironment keeps one only when the deployment
   * runs a single-operator auth mode (AUTH_MODE password or none).
   */
  workspaceIds?: readonly string[];
}

export type ConfiguredCodeRepositories = Readonly<Record<string, ConfiguredCodeRepository>>;

/**
 * The single refusal for a key this deployment does not serve to the caller's
 * Workspace. An unconfigured key and a key bound to other Workspaces must be
 * indistinguishable, or the response would enumerate the operator's registry.
 */
export const CODE_REPOSITORY_NOT_CONFIGURED = "repositoryKey is not configured by this deployment";

export interface EnqueueConfiguredCodeRevisionInput {
  repositoryKey: string;
  commitOid: string;
  sourceRef?: string;
}

interface RepositoryRow {
  id: string;
}

interface CodeIndexJobRow {
  id: string;
  repository_id: string;
  repository_key: string;
  commit_oid: string;
  source_ref: string | null;
  indexer_revision: string;
  status: CodeIndexJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: Date | string;
  completed_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function toCodeIndexJob(row: CodeIndexJobRow): CodeIndexJob {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryKey: row.repository_key,
    commitOid: row.commit_oid,
    sourceRef: row.source_ref,
    indexerRevision: row.indexer_revision,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maximumAttempts: Number(row.max_attempts),
    availableAt: timestamp(row.available_at),
    completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    lastError: row.last_error,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

/**
 * Resolves a configured repository for one Workspace, or undefined when this
 * deployment does not serve that key to it. The request path and the
 * maintenance worker both use it, so a registry change after enqueue takes
 * effect before any Git object is read.
 */
export function configuredCodeRepositoryForWorkspace(
  repositories: ConfiguredCodeRepositories,
  repositoryKey: string,
  workspaceId: string,
): ConfiguredCodeRepository | undefined {
  // Own-property only: a bare index would resolve inherited members, so a
  // model-supplied "toString" would read as a configured repository.
  const configured = Object.hasOwn(repositories, repositoryKey)
    ? repositories[repositoryKey]
    : undefined;
  if (!configured) return undefined;
  if (configured.workspaceIds && !configured.workspaceIds.includes(workspaceId.toLowerCase())) {
    return undefined;
  }
  return configured;
}

export function createCodeIndexQueueModule(
  database: PostgresDatabase,
  repositories: ConfiguredCodeRepositories,
) {
  return {
    async enqueue(
      actor: ActorContext,
      input: EnqueueConfiguredCodeRevisionInput,
    ): Promise<CodeIndexJob> {
      const repositoryKey = validatePlainText(input.repositoryKey, "repositoryKey", 512);
      const configured = configuredCodeRepositoryForWorkspace(
        repositories,
        repositoryKey,
        actor.workspaceId,
      );
      if (!configured) throw new CodeIndexValidationError(CODE_REPOSITORY_NOT_CONFIGURED);
      const displayName = validatePlainText(configured.displayName, "displayName", 200);
      const repositoryPath = validatePlainText(configured.repositoryPath, "repositoryPath", 4_096);
      const normalizedCommitOid = validateCommitOid(input.commitOid);
      const sourceRef = input.sourceRef
        ? validatePlainText(input.sourceRef, "sourceRef", 512)
        : null;
      try {
        return await database.transaction(async (transaction) => {
          await installActorContext(transaction, actor);
          const allowed = await transaction.query<{ allowed: boolean }>(
            "SELECT lore.can_write_code_index($1) AS allowed",
            [actor.workspaceId],
          );
          if (!allowed.rows[0]?.allowed) {
            throw new CodeIndexAccessDeniedError("Actor cannot queue code in this Workspace");
          }
          const inserted = await transaction.query<RepositoryRow>(
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
          let repositoryId = inserted.rows[0]?.id;
          if (!repositoryId) {
            const existing = await transaction.query<RepositoryRow>(
              `SELECT id FROM code_repositories
               WHERE workspace_id = $1 AND repository_key = $2`,
              [actor.workspaceId, repositoryKey],
            );
            repositoryId = existing.rows[0]?.id;
          }
          if (!repositoryId) {
            throw new CodeIndexAccessDeniedError("Repository is not visible to this Actor");
          }
          // The job key is unique per (repository, commit, indexer revision). The
          // database function inserts it, or re-arms a dead, cancelled, or
          // orphaned job for this Actor under that job's row lock.
          const queued = await transaction.query<{ id: string | null }>(
            "SELECT lore.enqueue_code_index_job($1, $2, $3, $4, $5) AS id",
            [repositoryId, repositoryPath, normalizedCommitOid, sourceRef, CODE_INDEX_REVISION],
          );
          const jobId = queued.rows[0]?.id;
          if (!jobId)
            throw new CodeIndexAccessDeniedError("Index job is not visible to this Actor");
          const result = await transaction.query<CodeIndexJobRow>(
            `SELECT job.id, job.repository_id, repository.repository_key,
               job.commit_oid, job.source_ref, job.indexer_revision, job.status,
               job.attempt_count, job.max_attempts, job.available_at,
               job.completed_at, job.last_error, job.created_at, job.updated_at
             FROM code_index_jobs job
             JOIN code_repositories repository
               ON repository.workspace_id = job.workspace_id
              AND repository.id = job.repository_id
             WHERE job.workspace_id = $1 AND job.id = $2`,
            [actor.workspaceId, jobId],
          );
          const job = result.rows[0];
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
  };
}

function isSingleOperatorAuthMode(environment: Readonly<Record<string, string | undefined>>) {
  // Only an explicit single-operator mode admits Workspace-unbound entries. An
  // unset AUTH_MODE is not taken as single-operator here, so a maintenance
  // worker that was not given the application's auth mode fails closed.
  return environment.AUTH_MODE === "password" || environment.AUTH_MODE === "none";
}

function workspaceIdList(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CodeIndexValidationError(
      `Configured Code Repository ${key} workspaceIds must be a non-empty array`,
    );
  }
  const workspaceIds = new Set<string>();
  for (const candidate of value) {
    const normalized = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    if (!WORKSPACE_ID_PATTERN.test(normalized)) {
      throw new CodeIndexValidationError(
        `Configured Code Repository ${key} workspaceIds must contain only Workspace UUIDs`,
      );
    }
    workspaceIds.add(normalized);
  }
  return [...workspaceIds];
}

/**
 * Parses LORE_CODE_REPOSITORIES. An entry may bind itself to Workspaces with
 * `workspaceIds`; an unbound entry is dropped unless AUTH_MODE is explicitly
 * password or none, because in a multi-user deployment it would let every
 * Workspace index the operator's repository.
 */
export function configuredCodeRepositoriesFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void = () => undefined,
): ConfiguredCodeRepositories {
  const encoded = environment.LORE_CODE_REPOSITORIES?.trim();
  if (!encoded) return {};
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new CodeIndexValidationError("LORE_CODE_REPOSITORIES must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodeIndexValidationError("LORE_CODE_REPOSITORIES must be a JSON object");
  }
  const singleOperator = isSingleOperatorAuthMode(environment);
  const result: Record<string, ConfiguredCodeRepository> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new CodeIndexValidationError(`Configured Code Repository ${key} is invalid`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.displayName !== "string" || typeof item.repositoryPath !== "string") {
      throw new CodeIndexValidationError(`Configured Code Repository ${key} is invalid`);
    }
    const repositoryKey = validatePlainText(key, "repositoryKey", 512);
    const repository: ConfiguredCodeRepository = {
      displayName: validatePlainText(item.displayName, "displayName", 200),
      repositoryPath: validatePlainText(item.repositoryPath, "repositoryPath", 4_096),
    };
    if (item.workspaceIds !== undefined) {
      result[repositoryKey] = {
        ...repository,
        workspaceIds: workspaceIdList(item.workspaceIds, repositoryKey),
      };
    } else if (singleOperator) {
      result[repositoryKey] = repository;
    } else {
      warn(
        `Lore ignored Code Repository ${repositoryKey}: an entry without workspaceIds is served only when AUTH_MODE is password or none`,
      );
    }
  }
  return result;
}
