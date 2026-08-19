import type { PostgresDatabase } from "@corespeed/lore-core";
import {
  type ActorContext,
  installActorContext,
  isPostgresAccessDenied,
} from "@corespeed/lore-core";
import type { CodeIndexJob, CodeIndexJobStatus } from "./code-index";
import { CodeIndexAccessDeniedError, CodeIndexValidationError } from "./code-index-errors";
import { CODE_INDEX_REVISION } from "./code-index-protocol";

export interface ConfiguredCodeRepository {
  displayName: string;
  repositoryPath: string;
}

export type ConfiguredCodeRepositories = Readonly<Record<string, ConfiguredCodeRepository>>;

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

function plainText(value: string, name: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized)) {
    throw new CodeIndexValidationError(`${name} is invalid`);
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function commitOid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(normalized)) {
    throw new CodeIndexValidationError("commitOid must be a full 40- or 64-character Git OID");
  }
  return normalized;
}

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

export function createCodeIndexQueueModule(
  database: PostgresDatabase,
  repositories: ConfiguredCodeRepositories,
) {
  return {
    async enqueue(
      actor: ActorContext,
      input: EnqueueConfiguredCodeRevisionInput,
    ): Promise<CodeIndexJob> {
      const repositoryKey = plainText(input.repositoryKey, "repositoryKey", 512);
      // Own-property only: a bare index would resolve inherited members, so a
      // model-supplied "toString" would read as a configured repository.
      const configured = Object.hasOwn(repositories, repositoryKey)
        ? repositories[repositoryKey]
        : undefined;
      if (!configured) {
        throw new CodeIndexValidationError("repositoryKey is not configured by this deployment");
      }
      const displayName = plainText(configured.displayName, "displayName", 200);
      const repositoryPath = plainText(configured.repositoryPath, "repositoryPath", 4_096);
      const normalizedCommitOid = commitOid(input.commitOid);
      const sourceRef = input.sourceRef ? plainText(input.sourceRef, "sourceRef", 512) : null;
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
              normalizedCommitOid,
              sourceRef,
              CODE_INDEX_REVISION,
              actor.userId,
              actor.agentId ?? null,
            ],
          );
          const result = await transaction.query<CodeIndexJobRow>(
            `SELECT job.id, job.repository_id, repository.repository_key,
               job.commit_oid, job.source_ref, job.indexer_revision, job.status,
               job.attempt_count, job.max_attempts, job.available_at,
               job.completed_at, job.last_error, job.created_at, job.updated_at
             FROM code_index_jobs job
             JOIN code_repositories repository
               ON repository.workspace_id = job.workspace_id
              AND repository.id = job.repository_id
             WHERE job.workspace_id = $1 AND job.repository_id = $2
               AND job.commit_oid = $3 AND job.indexer_revision = $4`,
            [actor.workspaceId, repositoryId, normalizedCommitOid, CODE_INDEX_REVISION],
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

export function configuredCodeRepositoriesFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
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
  const result: Record<string, ConfiguredCodeRepository> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new CodeIndexValidationError(`Configured Code Repository ${key} is invalid`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.displayName !== "string" || typeof item.repositoryPath !== "string") {
      throw new CodeIndexValidationError(`Configured Code Repository ${key} is invalid`);
    }
    result[plainText(key, "repositoryKey", 512)] = {
      displayName: plainText(item.displayName, "displayName", 200),
      repositoryPath: plainText(item.repositoryPath, "repositoryPath", 4_096),
    };
  }
  return result;
}
