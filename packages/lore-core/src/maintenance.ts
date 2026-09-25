import { type EmbeddingProvider, validatedEmbeddingDimensions } from "./capabilities";
import type { PostgresDatabase, PostgresTransaction } from "./db";
import { embeddingVectorLiterals } from "./vector";

/**
 * `lost` means this run no longer held the job's lease when it tried to finish:
 * another run reclaimed an expired lease (a slow provider), or the Memory was
 * deleted mid-embed and its job cascaded away. The job is not this run's to
 * finish, so it is a normal outcome rather than an infrastructure failure.
 */
export type MemoryMaintenanceStatus = "complete" | "retry" | "dead" | "idle" | "lost";

export interface MemoryMaintenanceResult {
  status: MemoryMaintenanceStatus;
  jobId?: string;
  retryAfterSeconds?: number;
}

export interface MemoryMaintenanceLog {
  event: "job_complete" | "job_retry" | "job_dead" | "job_lost";
  jobId: string;
  attempt: number;
  chunkCount: number;
}

export interface MemoryMaintenanceOptions {
  embeddingProvider: EmbeddingProvider;
  leaseSeconds?: number;
  logger?: (entry: MemoryMaintenanceLog) => void;
}

interface ClaimedJobDatabaseRow {
  id: string;
  workspace_id: string;
  memory_id: string;
  owner_user_id: string;
  memory_scope: "shared" | "private";
  memory_version: number;
  attempt_count: number;
  chunks: unknown;
}

interface ClaimedChunk {
  content: string;
  id: string;
  ordinal: number;
}

interface ClaimedJobRow extends Omit<ClaimedJobDatabaseRow, "chunks"> {
  chunks: ClaimedChunk[];
}

export interface EmbeddingGenerationReport {
  id: string;
  status: "active" | "building" | "failed" | "retiring";
  eligibleChunks: number;
  embeddedChunks: number;
  missingChunks: number;
  pendingJobs: number;
  deadJobs: number;
}

function retryDelay(attempt: number): number {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
}

export function embeddingMaintenanceLeaseSeconds(providerTimeoutMs = 120_000): number {
  const safeTimeoutMs =
    Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0 ? providerTimeoutMs : 120_000;
  // Reserve time for three nominal attempts plus database completion. This is
  // a reclaim/ownership window, not a request deadline: SDK backoff or batching
  // can exceed it, and native Ollama calls have no deadline. Expiry cannot
  // interrupt provider.embed(); a replacement lease token fences old completions.
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

export async function pruneRetiringEmbeddingGenerations(
  database: PostgresDatabase,
  retentionSeconds = 604_800,
): Promise<number> {
  const requestedRetentionSeconds = Math.floor(retentionSeconds);
  const safeRetentionSeconds =
    Number.isFinite(requestedRetentionSeconds) && requestedRetentionSeconds >= 3_600
      ? requestedRetentionSeconds
      : 604_800;
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ count: string | number }>(
      "SELECT lore.prune_retiring_embedding_generations($1) AS count",
      [safeRetentionSeconds],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

export function createMemoryMaintenanceModule(
  database: PostgresDatabase,
  options: MemoryMaintenanceOptions,
) {
  const provider = options.embeddingProvider;
  const providerDimensions = validatedEmbeddingDimensions(provider.dimensions);
  const leaseSeconds = Math.max(
    30,
    Math.min(options.leaseSeconds ?? embeddingMaintenanceLeaseSeconds(), 3_600),
  );
  const logger = options.logger ?? (() => undefined);

  function claimedChunks(value: unknown): ClaimedChunk[] {
    if (!Array.isArray(value)) throw new Error("Embedding job returned invalid chunks");
    return value.map((chunk) => {
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
        throw new Error("Embedding job returned an invalid chunk");
      }
      const item = chunk as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        typeof item.content !== "string" ||
        typeof item.ordinal !== "number" ||
        !Number.isInteger(item.ordinal) ||
        item.ordinal < 0
      ) {
        throw new Error("Embedding job returned an invalid chunk");
      }
      return { id: item.id, content: item.content, ordinal: item.ordinal };
    });
  }

  async function finishFailure(
    job: ClaimedJobRow,
    leaseToken: string,
    failureDetail: "Embedding provider request failed" | "Embedding maintenance transaction failed",
    chunkCount: number,
  ): Promise<MemoryMaintenanceResult> {
    const delay = retryDelay(job.attempt_count);
    const status = await database.transaction(async (transaction) => {
      const result = await transaction.query<{ status: "pending" | "dead" | null }>(
        `SELECT lore.finish_memory_embedding_job($1, $2, $3, $4) AS status`,
        [job.id, leaseToken, failureDetail, delay],
      );
      return result.rows[0]?.status ?? null;
    });
    // A NULL status means the lease is no longer ours. The replacement lease
    // token already fenced every write this run attempted.
    const outcome = status === null ? "lost" : status === "dead" ? "dead" : "retry";
    const event = ({ lost: "job_lost", dead: "job_dead", retry: "job_retry" } as const)[outcome];
    logger({ event, jobId: job.id, attempt: job.attempt_count, chunkCount });
    return outcome === "retry"
      ? { status: outcome, jobId: job.id, retryAfterSeconds: delay }
      : { status: outcome, jobId: job.id };
  }

  /** Reads coverage without creating the generation; null when it does not exist yet. */
  async function findGenerationReport(): Promise<EmbeddingGenerationReport | null> {
    return database.transaction(async (transaction) => {
      const result = await transaction.query<{
        id: string;
        status: EmbeddingGenerationReport["status"];
        eligible_chunks: string | number;
        embedded_chunks: string | number;
        missing_chunks: string | number;
        pending_jobs: string | number;
        dead_jobs: string | number;
      }>("SELECT * FROM lore.embedding_generation_report($1, $2, $3)", [
        provider.provider,
        provider.model,
        provider.revision,
      ]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        eligibleChunks: Number(row.eligible_chunks),
        embeddedChunks: Number(row.embedded_chunks),
        missingChunks: Number(row.missing_chunks),
        pendingJobs: Number(row.pending_jobs),
        deadJobs: Number(row.dead_jobs),
      };
    });
  }

  return {
    findGenerationReport,

    async generationReport(): Promise<EmbeddingGenerationReport> {
      const report = await findGenerationReport();
      if (!report) throw new Error("Embedding generation is not initialized");
      return report;
    },

    async activateGeneration(): Promise<string> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          "SELECT lore.activate_embedding_generation($1, $2, $3) AS id",
          [provider.provider, provider.model, provider.revision],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("Embedding generation activation failed");
        return id;
      });
    },

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
        const result = await transaction.query<ClaimedJobDatabaseRow>(
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
        const job = result.rows[0];
        return job ? { ...job, chunks: claimedChunks(job.chunks) } : null;
      });
      if (!claimed) return { status: "idle", ...(jobId ? { jobId } : {}) };

      const chunks = claimed.chunks;
      let vectors: string[];
      try {
        vectors = embeddingVectorLiterals(
          await provider.embed(
            chunks.map((chunk) => chunk.content),
            "document",
          ),
          chunks.length,
          providerDimensions,
        );
      } catch {
        return finishFailure(
          claimed,
          leaseToken,
          "Embedding provider request failed",
          chunks.length,
        );
      }

      try {
        await database.transaction(async (transaction) => {
          await installMaintenanceContext(transaction, claimed.id, leaseToken);
          // Memory mutations lock the parent Memory before replacing chunks.
          // Take the same parent-first order before the embedding insert obtains
          // foreign-key locks on generation/chunk rows, preventing a chunk ↔
          // Memory lock inversion with concurrent update/delete.
          const lockedMemory = await transaction.query<{ locked: boolean }>(
            "SELECT lore.lock_current_maintenance_memory() AS locked",
          );
          if (lockedMemory.rows[0]?.locked !== true) {
            throw new Error("Maintenance job Memory was deleted before completion");
          }
          const replacements = chunks.map((chunk, index) => ({
            chunk_id: chunk.id,
            embedding: vectors[index],
          }));
          const inserted = await transaction.query<{ id: string }>(
            `INSERT INTO memory_chunk_embeddings (
               generation_id, workspace_id, memory_id, chunk_id, embedding, embedded_at
             )
             SELECT
               lore.current_maintenance_generation_id(),
               $1,
               $2,
               replacement.chunk_id::uuid,
               replacement.embedding::vector(${providerDimensions}),
               now()
             FROM jsonb_to_recordset($3::jsonb) AS replacement(
               chunk_id text,
               embedding text
             )
             ON CONFLICT (generation_id, chunk_id)
             DO UPDATE SET embedding = EXCLUDED.embedding, embedded_at = now()
             RETURNING chunk_id AS id`,
            [claimed.workspace_id, claimed.memory_id, JSON.stringify(replacements)],
          );
          if (inserted.rows.length !== chunks.length) {
            throw new Error("Maintenance job failed to replace every claimed chunk");
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
        return finishFailure(
          claimed,
          leaseToken,
          "Embedding maintenance transaction failed",
          chunks.length,
        );
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

export type MemoryMaintenanceModule = ReturnType<typeof createMemoryMaintenanceModule>;

export function createMemoryMaintenanceCoordinator(maintenances: MemoryMaintenanceModule[]) {
  const lanes = [...maintenances];
  let nextRunLane = 0;

  return {
    async generationReports(): Promise<EmbeddingGenerationReport[]> {
      const reports: EmbeddingGenerationReport[] = [];
      for (const maintenance of lanes) {
        reports.push(await maintenance.generationReport());
      }
      return reports;
    },

    async seedStale(limitPerGeneration = 100): Promise<string[]> {
      const seeded: string[] = [];
      for (const maintenance of lanes) {
        seeded.push(...(await maintenance.seedStale(limitPerGeneration)));
      }
      return seeded;
    },

    async pending(limitPerGeneration = 100): Promise<string[]> {
      const pending: string[] = [];
      for (const maintenance of lanes) {
        pending.push(...(await maintenance.pending(limitPerGeneration)));
      }
      return pending;
    },

    async run(jobId?: string): Promise<MemoryMaintenanceResult> {
      if (lanes.length === 0) return { status: "idle", ...(jobId ? { jobId } : {}) };
      const startLane = jobId ? 0 : nextRunLane;
      for (let offset = 0; offset < lanes.length; offset += 1) {
        const laneIndex = (startLane + offset) % lanes.length;
        const lane = lanes[laneIndex];
        if (!lane) continue;
        const result = await lane.run(jobId);
        if (result.status !== "idle") {
          nextRunLane = (laneIndex + 1) % lanes.length;
          return result;
        }
      }
      nextRunLane = (startLane + 1) % lanes.length;
      return { status: "idle", ...(jobId ? { jobId } : {}) };
    },
  };
}
