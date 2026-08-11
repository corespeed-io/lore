import { sql } from "drizzle-orm";
import type { LoreDatabase, LoreTransaction } from "./db";
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
  // Provider HTTP adapters make at most three attempts. Keep the lease valid for
  // that worst-case wall time plus a one-minute database completion margin.
  return Math.max(30, Math.min(Math.ceil((safeTimeoutMs * 3) / 1_000) + 60, 3_600));
}

async function installMaintenanceContext(
  transaction: LoreTransaction,
  jobId: string,
  leaseToken: string,
): Promise<void> {
  await transaction.execute(
    sql`SELECT
       set_config('lore.maintenance_job_id', ${jobId}, true),
       set_config('lore.maintenance_lease_token', ${leaseToken}, true)`,
  );
}

export async function purgeExpiredPortableCoreRecords(
  database: LoreDatabase,
): Promise<{ idempotencyRecords: number; memoryEvents: number }> {
  return database.transaction(async (transaction) => {
    const result = await transaction.execute<{
      idempotency_records: string | number;
      memory_event_records: string | number;
    }>(sql`SELECT * FROM lore.purge_expired_portable_core_records()`);
    return {
      idempotencyRecords: Number(result.rows[0]?.idempotency_records ?? 0),
      memoryEvents: Number(result.rows[0]?.memory_event_records ?? 0),
    };
  });
}

export async function pruneRetiringEmbeddingGenerations(
  database: LoreDatabase,
  retentionSeconds = 604_800,
): Promise<number> {
  const requestedRetentionSeconds = Math.floor(retentionSeconds);
  const safeRetentionSeconds =
    Number.isFinite(requestedRetentionSeconds) && requestedRetentionSeconds >= 3_600
      ? requestedRetentionSeconds
      : 604_800;
  return database.transaction(async (transaction) => {
    const result = await transaction.execute<{ count: string | number }>(
      sql`SELECT lore.prune_retiring_embedding_generations(${safeRetentionSeconds}) AS count`,
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

export function createMemoryMaintenanceModule(
  database: LoreDatabase,
  options: MemoryMaintenanceOptions,
) {
  const provider = options.embeddingProvider;
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
      const result = await transaction.execute<{ status: "pending" | "dead" | null }>(
        sql`SELECT lore.finish_memory_embedding_job(
          ${job.id}, ${leaseToken}, ${failureDetail}, ${delay}
        ) AS status`,
      );
      return result.rows[0]?.status ?? null;
    });
    if (!status) throw new Error("Maintenance job lease was lost before failure completion");
    if (status === "dead") {
      logger({
        event: "job_dead",
        jobId: job.id,
        attempt: job.attempt_count,
        chunkCount,
      });
      return { status: "dead", jobId: job.id };
    }
    logger({
      event: "job_retry",
      jobId: job.id,
      attempt: job.attempt_count,
      chunkCount,
    });
    return { status: "retry", jobId: job.id, retryAfterSeconds: delay };
  }

  return {
    async generationReport(): Promise<EmbeddingGenerationReport> {
      return database.transaction(async (transaction) => {
        const result = await transaction.execute<{
          id: string;
          status: EmbeddingGenerationReport["status"];
          eligible_chunks: string | number;
          embedded_chunks: string | number;
          missing_chunks: string | number;
          pending_jobs: string | number;
          dead_jobs: string | number;
        }>(sql`SELECT * FROM lore.embedding_generation_report(
          ${provider.provider}, ${provider.model}, ${provider.revision}
        )`);
        const row = result.rows[0];
        if (!row) throw new Error("Embedding generation is not initialized");
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
    },

    async activateGeneration(): Promise<string> {
      return database.transaction(async (transaction) => {
        const result = await transaction.execute<{ id: string }>(
          sql`SELECT lore.activate_embedding_generation(
            ${provider.provider}, ${provider.model}, ${provider.revision}
          ) AS id`,
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("Embedding generation activation failed");
        return id;
      });
    },

    async purgeExpired(): Promise<{ idempotencyRecords: number; memoryEvents: number }> {
      return purgeExpiredPortableCoreRecords(database);
    },

    async pruneRetiringGenerations(retentionSeconds = 604_800): Promise<number> {
      return pruneRetiringEmbeddingGenerations(database, retentionSeconds);
    },

    async seedStale(limit = 100): Promise<string[]> {
      const safeLimit = Math.max(1, Math.min(limit, 10_000));
      return database.transaction(async (transaction) => {
        const result = await transaction.execute<{ id: string }>(
          sql`SELECT id
           FROM lore.enqueue_stale_memory_embedding_jobs(
             ${provider.provider}, ${provider.model}, ${provider.revision}, ${safeLimit}
           )`,
        );
        return result.rows.map((row) => row.id);
      });
    },

    async pending(limit = 100): Promise<string[]> {
      const safeLimit = Math.max(1, Math.min(limit, 10_000));
      return database.transaction(async (transaction) => {
        const result = await transaction.execute<{ id: string }>(
          sql`SELECT id
           FROM lore.list_pending_memory_embedding_jobs(
             ${provider.provider}, ${provider.model}, ${provider.revision},
             ${leaseSeconds}, ${safeLimit}
           )`,
        );
        return result.rows.map((row) => row.id);
      });
    },

    async run(jobId?: string): Promise<MemoryMaintenanceResult> {
      const leaseToken = crypto.randomUUID();
      const claimed = await database.transaction(async (transaction) => {
        const result = await transaction.execute<ClaimedJobDatabaseRow>(
          sql`SELECT *
           FROM lore.claim_memory_embedding_job(
             ${jobId ?? null}, ${provider.provider}, ${provider.model}, ${provider.revision},
             ${leaseToken}, ${leaseSeconds}
           )`,
        );
        const job = result.rows[0];
        return job ? { ...job, chunks: claimedChunks(job.chunks) } : null;
      });
      if (!claimed) return { status: "idle", jobId };

      const chunks = claimed.chunks;
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
          const lockedMemory = await transaction.execute<{ locked: boolean }>(
            sql`SELECT lore.lock_current_maintenance_memory() AS locked`,
          );
          if (lockedMemory.rows[0]?.locked !== true) {
            throw new Error("Maintenance job Memory was deleted before completion");
          }
          const replacements = chunks.map((chunk, index) => ({
            chunk_id: chunk.id,
            embedding: vectors[index],
          }));
          const inserted = await transaction.execute<{ id: string }>(
            sql`INSERT INTO memory_chunk_embeddings (
               generation_id, workspace_id, memory_id, chunk_id, embedding, embedded_at
             )
             SELECT
               lore.current_maintenance_generation_id(),
               ${claimed.workspace_id},
               ${claimed.memory_id},
               replacement.chunk_id::uuid,
               replacement.embedding::vector(1024),
               now()
             FROM jsonb_to_recordset(${JSON.stringify(replacements)}::jsonb) AS replacement(
               chunk_id text,
               embedding text
             )
             ON CONFLICT (generation_id, chunk_id)
             DO UPDATE SET embedding = EXCLUDED.embedding, embedded_at = now()
             RETURNING chunk_id AS id`,
          );
          if (inserted.rows.length !== chunks.length) {
            throw new Error("Maintenance job failed to replace every claimed chunk");
          }
          const finished = await transaction.execute<{ status: "succeeded" | null }>(
            sql`SELECT lore.finish_memory_embedding_job(
              ${claimed.id}, ${leaseToken}, NULL, ${1}
            ) AS status`,
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
      if (lanes.length === 0) return { status: "idle", jobId };
      const startLane = jobId ? 0 : nextRunLane;
      for (let offset = 0; offset < lanes.length; offset += 1) {
        const laneIndex = (startLane + offset) % lanes.length;
        const result = await lanes[laneIndex].run(jobId);
        if (result.status !== "idle") {
          nextRunLane = (laneIndex + 1) % lanes.length;
          return result;
        }
      }
      nextRunLane = (startLane + 1) % lanes.length;
      return { status: "idle", jobId };
    },
  };
}
