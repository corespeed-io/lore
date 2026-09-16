import type { PostgresDatabase } from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";
import { CODE_INDEX_REVISION } from "./protocol";
import { createCodeIndexModule } from "./service";
import type { CodeIndexJobStatus } from "./types";
import { validateUuid } from "./validation";

export type CodeIndexMaintenanceStatus = "complete" | "dead" | "idle" | "retry";

export interface CodeIndexMaintenanceResult {
  status: CodeIndexMaintenanceStatus;
  jobId?: string;
  generationId?: string;
  parsedFileCount?: number;
  reusedFileCount?: number;
  retryAfterSeconds?: number;
}

export interface CodeIndexMaintenanceLog {
  event: "job_complete" | "job_dead" | "job_retry";
  jobId: string;
  attempt: number;
}

export interface CodeIndexMaintenanceOptions {
  leaseSeconds?: number;
  logger?: (entry: CodeIndexMaintenanceLog) => void;
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

function codeIndexRetryDelay(attempt: number): number {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
}

export function createCodeIndexMaintenanceModule(
  database: PostgresDatabase,
  options: CodeIndexMaintenanceOptions = {},
) {
  const leaseSeconds = Math.max(30, Math.min(options.leaseSeconds ?? 900, 3_600));
  const logger = options.logger ?? (() => undefined);

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
      try {
        const indexed = await code.indexGitRevision(actor, {
          repositoryKey: claimed.repository_key,
          displayName: claimed.display_name,
          repositoryPath: claimed.repository_path,
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
      } catch {
        const delay = codeIndexRetryDelay(claimed.attempt_count);
        const failed = await database.transaction(async (transaction) => {
          const result = await transaction.query<{ status: CodeIndexJobStatus | null }>(
            "SELECT lore.finish_code_index_job($1, $2, $3, $4) AS status",
            [claimed.id, leaseToken, "Code Index processing failed", delay],
          );
          return result.rows[0]?.status ?? null;
        });
        if (!failed) throw new Error("Code Index job lease was lost before failure completion");
        if (failed === "dead") {
          logger({ event: "job_dead", jobId: claimed.id, attempt: claimed.attempt_count });
          return { status: "dead", jobId: claimed.id };
        }
        logger({ event: "job_retry", jobId: claimed.id, attempt: claimed.attempt_count });
        return { status: "retry", jobId: claimed.id, retryAfterSeconds: delay };
      }
    },
  };
}
