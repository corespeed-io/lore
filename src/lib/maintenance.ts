import type { PostgresDatabase, PostgresTransaction } from "./db";
import { embeddingVectorLiterals } from "./embedding/vector";
import type { EmbeddingProvider } from "./memory";

export type MemoryMaintenanceStatus = "complete" | "retry" | "dead" | "idle";

export interface MemoryMaintenanceResult {
  status: MemoryMaintenanceStatus;
  jobId?: string;
  retryAfterSeconds?: number;
}

export interface MemoryMaintenanceLog {
  event: "job_complete" | "job_retry" | "job_dead";
  jobId: string;
  attempt: number;
  chunkCount: number;
}

export interface MemoryMaintenanceOptions {
  embeddingProvider: EmbeddingProvider;
  leaseSeconds?: number;
  logger?: (entry: MemoryMaintenanceLog) => void;
}

interface ClaimedChunk {
  id: string;
  content: string;
}

interface ClaimedJobRow {
  id: string;
  workspace_id: string;
  memory_id: string;
  owner_user_id: string;
  memory_scope: "shared" | "private";
  memory_version: number;
  attempt_count: number;
  chunks: unknown;
}

function parseChunks(value: unknown): ClaimedChunk[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (chunk) =>
        !chunk ||
        typeof chunk !== "object" ||
        typeof (chunk as ClaimedChunk).id !== "string" ||
        typeof (chunk as ClaimedChunk).content !== "string",
    )
  ) {
    throw new Error("Maintenance job returned invalid chunks");
  }
  return parsed as ClaimedChunk[];
}

function retryDelay(attempt: number): number {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
}

export function embeddingMaintenanceLeaseSeconds(providerTimeoutMs = 120_000): number {
  const safeTimeoutMs =
    Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0 ? providerTimeoutMs : 120_000;
  // Provider HTTP adapters make at most three attempts. Keep the lease valid for
  // that worst-case wall time plus a one-minute database completion margin.
  return Math.max(30, Math.min(Math.ceil((safeTimeoutMs * 3) / 1_000) + 60, 3_600));
}

async function installMaintenanceContext(
  transaction: PostgresTransaction,
  jobId: string,
  leaseToken: string,
): Promise<void> {
  await transaction.query(
    `SELECT
       set_config('lore.maintenance_job_id', $1, true),
       set_config('lore.maintenance_lease_token', $2, true)`,
    [jobId, leaseToken],
  );
}

export function createMemoryMaintenanceModule(
  database: PostgresDatabase,
  options: MemoryMaintenanceOptions,
) {
  const provider = options.embeddingProvider;
  const leaseSeconds = Math.max(
    30,
    Math.min(options.leaseSeconds ?? embeddingMaintenanceLeaseSeconds(), 3_600),
  );
  const logger = options.logger ?? (() => undefined);

  async function finishFailure(
    job: ClaimedJobRow,
    leaseToken: string,
  ): Promise<MemoryMaintenanceResult> {
    const delay = retryDelay(job.attempt_count);
    const status = await database.transaction(async (transaction) => {
      const result = await transaction.query<{ status: "pending" | "dead" | null }>(
        `SELECT lore.finish_memory_embedding_job($1, $2, $3, $4) AS status`,
        [job.id, leaseToken, "Embedding provider request failed", delay],
      );
      return result.rows[0]?.status ?? null;
    });
    if (!status) throw new Error("Maintenance job lease was lost before failure completion");
    const chunks = parseChunks(job.chunks);
    if (status === "dead") {
      logger({
        event: "job_dead",
        jobId: job.id,
        attempt: job.attempt_count,
        chunkCount: chunks.length,
      });
      return { status: "dead", jobId: job.id };
    }
    logger({
      event: "job_retry",
      jobId: job.id,
      attempt: job.attempt_count,
      chunkCount: chunks.length,
    });
    return { status: "retry", jobId: job.id, retryAfterSeconds: delay };
  }

  return {
    async seedStale(limit = 100): Promise<string[]> {
      const safeLimit = Math.max(1, Math.min(limit, 10_000));
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          `SELECT id
           FROM lore.enqueue_stale_memory_embedding_jobs($1, $2, $3, $4)`,
          [provider.provider, provider.model, provider.revision, safeLimit],
        );
        return result.rows.map((row) => row.id);
      });
    },

    async pending(limit = 100): Promise<string[]> {
      const safeLimit = Math.max(1, Math.min(limit, 10_000));
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          `SELECT id
           FROM lore.list_pending_memory_embedding_jobs($1, $2, $3, $4, $5)`,
          [provider.provider, provider.model, provider.revision, leaseSeconds, safeLimit],
        );
        return result.rows.map((row) => row.id);
      });
    },

    async run(jobId?: string): Promise<MemoryMaintenanceResult> {
      const leaseToken = crypto.randomUUID();
      const claimed = await database.transaction(async (transaction) => {
        const result = await transaction.query<ClaimedJobRow>(
          `SELECT *
           FROM lore.claim_memory_embedding_job($1, $2, $3, $4, $5, $6)`,
          [
            jobId ?? null,
            provider.provider,
            provider.model,
            provider.revision,
            leaseToken,
            leaseSeconds,
          ],
        );
        return result.rows[0] ?? null;
      });
      if (!claimed) return { status: "idle", jobId };

      const chunks = parseChunks(claimed.chunks);
      let vectors: string[];
      try {
        vectors = embeddingVectorLiterals(
          await provider.embed(
            chunks.map((chunk) => chunk.content),
            "document",
          ),
          chunks.length,
        );
      } catch {
        return finishFailure(claimed, leaseToken);
      }

      try {
        await database.transaction(async (transaction) => {
          await installMaintenanceContext(transaction, claimed.id, leaseToken);
          for (const [index, chunk] of chunks.entries()) {
            const result = await transaction.query<{ id: string }>(
              `UPDATE memory_chunks
               SET embedding = $3::vector(1024),
                   embedding_provider = $4,
                   embedding_model = $5,
                   embedding_revision = $6,
                   embedded_at = now(),
                   updated_at = now()
               WHERE workspace_id = $1 AND id = $2
               RETURNING id`,
              [
                claimed.workspace_id,
                chunk.id,
                vectors[index],
                provider.provider,
                provider.model,
                provider.revision,
              ],
            );
            if (result.rows.length !== 1) {
              throw new Error("Maintenance job lost access to a claimed chunk");
            }
          }
          const finished = await transaction.query<{ status: "succeeded" | null }>(
            `SELECT lore.finish_memory_embedding_job($1, $2, NULL, $3) AS status`,
            [claimed.id, leaseToken, 1],
          );
          if (finished.rows[0]?.status !== "succeeded") {
            throw new Error("Maintenance job lease was lost before success completion");
          }
        });
      } catch {
        return finishFailure(claimed, leaseToken);
      }

      logger({
        event: "job_complete",
        jobId: claimed.id,
        attempt: claimed.attempt_count,
        chunkCount: chunks.length,
      });
      return { status: "complete", jobId: claimed.id };
    },
  };
}
