import { type EmbeddingProvider, validatedEmbeddingDimensions } from "./capabilities";
import { type PostgresDatabase, type PostgresTransaction, statement } from "./db";
import type { MemoryEmbeddingJobMessage } from "./memory-types";
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

/** `invalid`: the queue message was not `{ jobId: string }`; nothing was claimed. */
export type EmbeddingMaintenanceRunResult = MemoryMaintenanceResult | { status: "invalid" };

/** One vector space. Vectors are comparable only within one identity. */
export type EmbeddingGenerationIdentity = Pick<
  EmbeddingProvider,
  "provider" | "model" | "dimensions" | "revision"
>;

/** A job outcome, named with the generation it belongs to so hosts only format it. */
export interface EmbeddingMaintenanceLog {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingRevision: string;
  event: "job_complete" | "job_retry" | "job_dead" | "job_lost";
  jobId: string;
  attempt: number;
  chunkCount: number;
}

export interface EmbeddingMaintenanceOptions {
  /**
   * One lane per generation to maintain: the serving provider first, then a
   * building provider during a rollout. Empty disables embedding maintenance;
   * `sweep` still prunes expired retiring generations.
   */
  embeddingProviders: readonly EmbeddingProvider[];
  /** How long a retired generation stays available for rollback (default 7 days, minimum 1 hour). */
  generationRetentionSeconds?: number;
  logger?: (entry: EmbeddingMaintenanceLog) => void;
}

export interface EmbeddingMaintenanceSweep {
  /** Expired retiring generations deleted. */
  prunedGenerations: number;
  /** Jobs enqueued for chunks without a current vector, at most 1,000 per generation. */
  seeded: string[];
  /** One coverage report per lane, in lane order. */
  generations: EmbeddingGenerationReport[];
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

const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const DEFAULT_GENERATION_RETENTION_SECONDS = 604_800;
const SWEEP_SEED_LIMIT_PER_GENERATION = 1_000;

function retryDelay(attempt: number): number {
  return Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
}

/**
 * The lease a lane claims jobs with. A provider without a request deadline gets
 * the window of a nominal 120-second request.
 */
export function embeddingMaintenanceLeaseSeconds(
  requestTimeoutMs: number | undefined = DEFAULT_PROVIDER_TIMEOUT_MS,
): number {
  const safeTimeoutMs =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : DEFAULT_PROVIDER_TIMEOUT_MS;
  // Reserve time for three nominal attempts plus database completion. This is
  // a reclaim/ownership window, not a request deadline: SDK backoff or batching
  // can exceed it, and native Ollama calls have no deadline. Expiry cannot
  // interrupt provider.embed(); a replacement lease token fences old completions.
  return Math.max(30, Math.min(Math.ceil((safeTimeoutMs * 3) / 1_000) + 60, 3_600));
}

function isJobMessage(value: unknown): value is MemoryEmbeddingJobMessage {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as MemoryEmbeddingJobMessage).jobId === "string"
  );
}

/** The lease context travels with the transaction's next statement. */
function installMaintenanceContext(
  transaction: PostgresTransaction,
  jobId: string,
  leaseToken: string,
): void {
  transaction.setLocal({
    "lore.maintenance_job_id": jobId,
    "lore.maintenance_lease_token": leaseToken,
  });
}

async function pruneRetiringGenerations(
  database: PostgresDatabase,
  retentionSeconds = DEFAULT_GENERATION_RETENTION_SECONDS,
): Promise<number> {
  const requestedRetentionSeconds = Math.floor(retentionSeconds);
  const safeRetentionSeconds =
    Number.isFinite(requestedRetentionSeconds) && requestedRetentionSeconds >= 3_600
      ? requestedRetentionSeconds
      : DEFAULT_GENERATION_RETENTION_SECONDS;
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ count: string | number }>(
      "SELECT lore.prune_retiring_embedding_generations($1) AS count",
      [safeRetentionSeconds],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

/** Reads coverage without creating the generation; null when it does not exist yet. */
async function findGenerationReport(
  database: PostgresDatabase,
  identity: EmbeddingGenerationIdentity,
): Promise<EmbeddingGenerationReport | null> {
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
      identity.provider,
      identity.model,
      identity.revision,
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

/** One generation's jobs: claim, embed, write, finish. */
function createEmbeddingLane(
  database: PostgresDatabase,
  provider: EmbeddingProvider,
  logger: (entry: EmbeddingMaintenanceLog) => void,
) {
  const providerDimensions = validatedEmbeddingDimensions(provider.dimensions);
  const leaseSeconds = embeddingMaintenanceLeaseSeconds(provider.requestTimeoutMs);
  const generationFields = {
    embeddingProvider: provider.provider,
    embeddingModel: provider.model,
    embeddingRevision: provider.revision,
  };
  const log = (entry: Omit<EmbeddingMaintenanceLog, keyof typeof generationFields>) =>
    logger({ ...generationFields, ...entry });

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
    log({ event, jobId: job.id, attempt: job.attempt_count, chunkCount });
    return outcome === "retry"
      ? { status: outcome, jobId: job.id, retryAfterSeconds: delay }
      : { status: outcome, jobId: job.id };
  }

  return {
    async generationReport(): Promise<EmbeddingGenerationReport> {
      const report = await findGenerationReport(database, provider);
      if (!report) throw new Error("Embedding generation is not initialized");
      return report;
    },

    async seedStale(limit: number): Promise<string[]> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          `SELECT id
           FROM lore.enqueue_stale_memory_embedding_jobs($1, $2, $3, $4)`,
          [provider.provider, provider.model, provider.revision, limit],
        );
        return result.rows.map((row) => row.id);
      });
    },

    async pending(limit: number): Promise<string[]> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          `SELECT id
           FROM lore.list_pending_memory_embedding_jobs($1, $2, $3, $4, $5)`,
          [provider.provider, provider.model, provider.revision, leaseSeconds, limit],
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

      // A claim returns only the chunks that still lack a vector in this
      // generation. When none does, the job completes without a provider call.
      const chunks = claimed.chunks;
      let vectors: string[] = [];
      try {
        if (chunks.length > 0) {
          vectors = embeddingVectorLiterals(
            await provider.embed(
              chunks.map((chunk) => chunk.content),
              "document",
            ),
            chunks.length,
            providerDimensions,
          );
        }
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
          installMaintenanceContext(transaction, claimed.id, leaseToken);
          const replacements = chunks.map((chunk, index) => ({
            chunk_id: chunk.id,
            embedding: vectors[index],
          }));
          // Memory mutations lock the parent Memory before replacing chunks. Take
          // the same parent-first order before the embedding insert obtains
          // foreign-key locks on generation/chunk rows, preventing a chunk ↔ Memory
          // lock inversion with concurrent update/delete. The three statements
          // share one round trip; COMMIT follows only once their results check out.
          // A claim with no chunk left to embed inserts nothing and only finishes.
          const [lockedMemory, inserted, finished] = await transaction.batch([
            statement<{ locked: boolean }>(
              "SELECT lore.lock_current_maintenance_memory() AS locked",
            ),
            statement<{ id: string }>(
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
            ),
            statement<{ status: "succeeded" | null }>(
              "SELECT lore.finish_memory_embedding_job($1, $2, NULL, $3) AS status",
              [claimed.id, leaseToken, 1],
            ),
          ]);
          if (lockedMemory.rows[0]?.locked !== true) {
            throw new Error("Maintenance job Memory was deleted before completion");
          }
          if (inserted.rows.length !== chunks.length) {
            throw new Error("Maintenance job failed to replace every claimed chunk");
          }
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

      log({
        event: "job_complete",
        jobId: claimed.id,
        attempt: claimed.attempt_count,
        chunkCount: chunks.length,
      });
      return { status: "complete", jobId: claimed.id };
    },
  };
}

/**
 * Leased document embedding for every configured generation. Hosts own the
 * transport (a polling loop, a queue consumer, a scheduled sweep), concurrency,
 * and log format; this owns lanes, leases, retries, seeding, and pruning.
 */
export function createEmbeddingMaintenance(
  database: PostgresDatabase,
  options: EmbeddingMaintenanceOptions,
) {
  const logger = options.logger ?? (() => undefined);
  const lanes = options.embeddingProviders.map((provider) =>
    createEmbeddingLane(database, provider, logger),
  );
  let nextRunLane = 0;

  async function runLanes(jobId?: string): Promise<MemoryMaintenanceResult> {
    if (lanes.length === 0) return { status: "idle", ...(jobId ? { jobId } : {}) };
    // A named job may belong to any lane, so it tries them in order; an unnamed
    // claim rotates its starting lane so one generation cannot starve the other.
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
  }

  /**
   * Claim and finish one job: the job a queue message names, or any due job
   * when called without one. A malformed message is `invalid`, never thrown.
   */
  function run(): Promise<MemoryMaintenanceResult>;
  function run(message: unknown): Promise<EmbeddingMaintenanceRunResult>;
  async function run(...args: [] | [unknown]): Promise<EmbeddingMaintenanceRunResult> {
    // Decided by whether a message was passed, not by its value: a queue message
    // whose body is undefined is malformed, never "any due job".
    if (args.length === 0) return runLanes();
    const [message] = args;
    if (!isJobMessage(message)) return { status: "invalid" };
    return runLanes(message.jobId);
  }

  return {
    /** False when no embedding provider is configured. */
    enabled: lanes.length > 0,

    run,

    /**
     * The deployment backstop: prune expired retiring generations, enqueue jobs
     * for chunks without a current vector, and report each lane's coverage.
     */
    async sweep(): Promise<EmbeddingMaintenanceSweep> {
      const prunedGenerations = await pruneRetiringGenerations(
        database,
        options.generationRetentionSeconds,
      );
      const seeded: string[] = [];
      for (const lane of lanes) {
        seeded.push(...(await lane.seedStale(SWEEP_SEED_LIMIT_PER_GENERATION)));
      }
      const generations: EmbeddingGenerationReport[] = [];
      for (const lane of lanes) generations.push(await lane.generationReport());
      return { prunedGenerations, seeded, generations };
    },

    /** Queue messages for jobs that are due now, at most `limit` per generation. */
    async pending(limit = 100): Promise<MemoryEmbeddingJobMessage[]> {
      const safeLimit = Math.max(1, Math.min(limit, 10_000));
      const messages: MemoryEmbeddingJobMessage[] = [];
      for (const lane of lanes) {
        for (const jobId of await lane.pending(safeLimit)) messages.push({ jobId });
      }
      return messages;
    },
  };
}

export type EmbeddingMaintenance = ReturnType<typeof createEmbeddingMaintenance>;

/** Operator control of embedding generations; it never calls a provider. */
export function createEmbeddingGenerationAdmin(database: PostgresDatabase) {
  return {
    /** Coverage of one generation; null when it does not exist yet. Never creates it. */
    findReport(identity: EmbeddingGenerationIdentity): Promise<EmbeddingGenerationReport | null> {
      return findGenerationReport(database, identity);
    },

    /** Atomically make one complete generation active; the previous one starts retiring. */
    async activate(identity: EmbeddingGenerationIdentity): Promise<string> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ id: string }>(
          "SELECT lore.activate_embedding_generation($1, $2, $3) AS id",
          [identity.provider, identity.model, identity.revision],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("Embedding generation activation failed");
        return id;
      });
    },

    /**
     * Count one generation's current dead jobs, or with `apply` re-arm them as
     * pending with a fresh retry budget. Returns the count either way.
     */
    async requeueDeadJobs(generationId: string, options: { apply: boolean }): Promise<number> {
      return database.transaction(async (transaction) => {
        const result = await transaction.query<{ count: string | number }>(
          "SELECT lore.requeue_dead_memory_embedding_jobs($1, $2) AS count",
          [generationId, options.apply],
        );
        return Number(result.rows[0]?.count ?? 0);
      });
    },
  };
}

/**
 * Whether search can use vectors of this identity: an active or retiring
 * generation matches its provider, model, dimensions, and revision.
 */
export async function embeddingGenerationServing(
  transaction: PostgresTransaction,
  identity: EmbeddingGenerationIdentity,
): Promise<boolean> {
  const result = await transaction.query<{ serving: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM embedding_generations generation
       WHERE generation.embedding_provider = $1
         AND generation.embedding_model = $2
         AND generation.embedding_dimensions = $3
         AND generation.embedding_revision = $4
         AND generation.status IN ('active', 'retiring')
     ) AS serving`,
    [identity.provider, identity.model, identity.dimensions, identity.revision],
  );
  return result.rows[0]?.serving === true;
}
