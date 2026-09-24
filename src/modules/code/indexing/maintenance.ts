import type { PostgresDatabase } from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";
import { CodeIndexValidationError, CodeRevisionConflictError } from "./errors";
import { CODE_INDEX_REVISION } from "./protocol";
import type { ConfiguredCodeRepositories } from "./queue";
import { CODE_REPOSITORY_NOT_CONFIGURED, configuredCodeRepositoryForWorkspace } from "./queue";
import { createCodeIndexModule } from "./service";
import type { CodeIndexJobStatus } from "./types";
import { validateUuid } from "./validation";

/**
 * `lost` means another claim or an Agent lifecycle change took this job's lease
 * while it ran. The job is someone else's to finish; it is a normal outcome, not
 * an infrastructure failure.
 */
export type CodeIndexMaintenanceStatus = "complete" | "dead" | "idle" | "lost" | "retry";

export interface CodeIndexMaintenanceResult {
  status: CodeIndexMaintenanceStatus;
  jobId?: string;
  generationId?: string;
  parsedFileCount?: number;
  reusedFileCount?: number;
  retryAfterSeconds?: number;
}

export interface CodeIndexMaintenanceLog {
  event: "job_complete" | "job_dead" | "job_lost" | "job_retry";
  jobId: string;
  attempt: number;
  /** Class name of the failure; never its message, which can carry server paths. */
  errorClass?: string;
  /** SQLSTATE of a database failure, when there is one. */
  sqlState?: string;
}

export interface CodeIndexMaintenanceOptions {
  leaseSeconds?: number;
  logger?: (entry: CodeIndexMaintenanceLog) => void;
  /**
   * The worker's own LORE_CODE_REPOSITORIES registry. Each claimed job resolves
   * its repository path by key here and re-checks the Workspace binding, so the
   * path the request role wrote into the job row is never read.
   */
  repositories: ConfiguredCodeRepositories;
}

interface ClaimedCodeIndexJobRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  repository_key: string;
  display_name: string;
  repository_path: string;
  commit_oid: string;
  source_ref: string | null;
  indexer_revision: string;
  requested_by_user_id: string;
  requested_by_agent_id: string | null;
  attempt_count: number;
}

/** Persisted for every transient failure; the retry budget absorbs these. */
const TRANSIENT_FAILURE_DETAIL = "Code Index processing failed";

export interface CodeIndexFailure {
  /** A deterministic failure repeats on every retry of the same job. */
  terminal: boolean;
  /** Content-free text stored in last_error and shown to Workspace readers. */
  detail: string;
  errorClass: string;
  sqlState?: string;
}

function isIncompleteGenerationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P0001" && error.message.startsWith("Code Index generation is incomplete");
}

/**
 * Separates failures that cannot succeed on retry from transient ones.
 * Validation and conflict messages name only repository-relative paths, OIDs,
 * and counts, never the operator's repository path, and the incomplete-generation
 * raise carries only counts. A message that nonetheless contains any value in
 * `serverOnly` falls back to the generic detail.
 */
export function classifyCodeIndexFailure(
  error: unknown,
  serverOnly: readonly string[],
): CodeIndexFailure {
  const errorClass = error instanceof Error ? error.constructor.name : "NonErrorThrow";
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const sqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  const terminal =
    error instanceof CodeIndexValidationError ||
    error instanceof CodeRevisionConflictError ||
    isIncompleteGenerationError(error);
  if (!terminal || !(error instanceof Error)) {
    return {
      terminal: false,
      detail: TRANSIENT_FAILURE_DETAIL,
      errorClass,
      ...(sqlState ? { sqlState } : {}),
    };
  }
  const message = error.message.trim();
  const revealsServerData = serverOnly.some((value) => value !== "" && message.includes(value));
  return {
    terminal: true,
    detail: message && !revealsServerData ? message.slice(0, 1_000) : TRANSIENT_FAILURE_DETAIL,
    errorClass,
    ...(sqlState ? { sqlState } : {}),
  };
}

function codeIndexRetryDelay(attempt: number): number {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
}

export function createCodeIndexMaintenanceModule(
  database: PostgresDatabase,
  options: CodeIndexMaintenanceOptions,
) {
  const leaseSeconds = Math.max(30, Math.min(options.leaseSeconds ?? 900, 3_600));
  const logger = options.logger ?? (() => undefined);
  const repositories = options.repositories;

  function repositoryPathFor(claimed: ClaimedCodeIndexJobRow): string {
    const configured = configuredCodeRepositoryForWorkspace(
      repositories,
      claimed.repository_key,
      claimed.workspace_id,
    );
    if (!configured) throw new CodeIndexValidationError(CODE_REPOSITORY_NOT_CONFIGURED);
    return configured.repositoryPath;
  }

  return {
    async run(requestedJobId?: string): Promise<CodeIndexMaintenanceResult> {
      const jobId = requestedJobId ? validateUuid(requestedJobId, "jobId") : null;
      const leaseToken = crypto.randomUUID();
      const claimed = await database.transaction(async (transaction) => {
        const result = await transaction.query<ClaimedCodeIndexJobRow>(
          "SELECT * FROM lore.claim_code_index_job($1, $2, $3, $4)",
          [jobId, CODE_INDEX_REVISION, leaseToken, leaseSeconds],
        );
        return result.rows[0] ?? null;
      });
      if (!claimed) return { status: "idle" };
      if (claimed.indexer_revision !== CODE_INDEX_REVISION) {
        throw new Error("Claimed Code Index job has an incompatible indexer revision");
      }
      const actor: ActorContext = {
        workspaceId: claimed.workspace_id,
        userId: claimed.requested_by_user_id,
        ...(claimed.requested_by_agent_id ? { agentId: claimed.requested_by_agent_id } : {}),
      };
      const code = createCodeIndexModule(database, {
        maintenanceLease: {
          jobId: claimed.id,
          leaseToken,
          repositoryId: claimed.repository_id,
        },
      });
      let repositoryPath: string | undefined;
      try {
        repositoryPath = repositoryPathFor(claimed);
        const indexed = await code.indexGitRevision(actor, {
          repositoryKey: claimed.repository_key,
          displayName: claimed.display_name,
          repositoryPath,
          commitOid: claimed.commit_oid,
          ...(claimed.source_ref ? { sourceRef: claimed.source_ref } : {}),
        });
        const completed = await database.transaction(async (transaction) => {
          const result = await transaction.query<{ status: CodeIndexJobStatus | null }>(
            "SELECT lore.complete_code_index_job($1, $2, $3) AS status",
            [claimed.id, leaseToken, indexed.generationId],
          );
          return result.rows[0]?.status ?? null;
        });
        if (completed !== "succeeded") {
          throw new Error("Code Index job lease was lost before completion");
        }
        logger({ event: "job_complete", jobId: claimed.id, attempt: claimed.attempt_count });
        return {
          status: "complete",
          jobId: claimed.id,
          generationId: indexed.generationId,
          parsedFileCount: indexed.parsedFileCount,
          reusedFileCount: indexed.reusedFileCount,
        };
      } catch (error) {
        const failure = classifyCodeIndexFailure(error, [
          claimed.repository_path,
          ...(repositoryPath ? [repositoryPath] : []),
        ]);
        const diagnostics = {
          errorClass: failure.errorClass,
          ...(failure.sqlState ? { sqlState: failure.sqlState } : {}),
        };
        const delay = codeIndexRetryDelay(claimed.attempt_count);
        const failed = await database.transaction(async (transaction) => {
          const result = failure.terminal
            ? await transaction.query<{ status: CodeIndexJobStatus | null }>(
                "SELECT lore.fail_code_index_job($1, $2, $3) AS status",
                [claimed.id, leaseToken, failure.detail],
              )
            : await transaction.query<{ status: CodeIndexJobStatus | null }>(
                "SELECT lore.finish_code_index_job($1, $2, $3, $4) AS status",
                [claimed.id, leaseToken, failure.detail, delay],
              );
          return result.rows[0]?.status ?? null;
        });
        if (!failed) {
          logger({
            event: "job_lost",
            jobId: claimed.id,
            attempt: claimed.attempt_count,
            ...diagnostics,
          });
          return { status: "lost", jobId: claimed.id };
        }
        if (failed === "dead") {
          logger({
            event: "job_dead",
            jobId: claimed.id,
            attempt: claimed.attempt_count,
            ...diagnostics,
          });
          return { status: "dead", jobId: claimed.id };
        }
        logger({
          event: "job_retry",
          jobId: claimed.id,
          attempt: claimed.attempt_count,
          ...diagnostics,
        });
        return { status: "retry", jobId: claimed.id, retryAfterSeconds: delay };
      }
    },
  };
}
