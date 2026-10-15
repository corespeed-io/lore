import { createEmbeddingMaintenance, type EmbeddingProvider } from "@corespeed/lore-core";
import pg from "pg";
import { createPostgresDatabase } from "../../../src/server/database/postgres";
import { drainEmbeddingMaintenance } from "../shared/embedding-maintenance-drain";
import type { EmbeddingCacheCounters } from "./embedding-cache";
import type { EvalUnit, IngestOutcome, SystemContext } from "./types";

/** The harness's two fixed users: Alice owns the corpus, Bob owns the tripwires. */
export const ALICE = "00000000-0000-4000-8000-000000000901";
export const BOB = "00000000-0000-4000-8000-000000000902";

/** The benchmark embedding space: Lore's production-shaped 1536 track. */
export const EMBEDDING_SPACE = {
  provider: "google",
  model: "gemini-embedding-2",
  dimensions: 1536,
  revision: "lore-embedding-v1",
} as const;

/** Units seeded at once, and embedding leases drained at once, per sandbox. */
const SEED_UNITS_AT_ONCE = 16;
const DRAIN_LEASES = 16;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function parallel<T>(
  items: readonly T[],
  concurrency: number,
  use: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await use(item);
      }
    }),
  );
}

export interface SystemDatabases {
  request: ReturnType<typeof createPostgresDatabase>;
  maintenance: ReturnType<typeof createPostgresDatabase>;
  admin: pg.Pool;
}

/**
 * One system's connections to its eval database. Pools are sized so two
 * sandboxes seeding at once stay under a 100-connection server, and idle
 * connections close, so seeding's free up for the drain.
 */
export function systemDatabases(): {
  connect(databaseUrl: string): SystemDatabases;
  close(): Promise<void>;
} {
  let databases: SystemDatabases | undefined;
  return {
    connect(databaseUrl) {
      databases ??= {
        request: createPostgresDatabase({
          connectionString: databaseUrl,
          max: SEED_UNITS_AT_ONCE,
          idleTimeoutMillis: 5_000,
        }),
        maintenance: createPostgresDatabase(
          { connectionString: databaseUrl, max: DRAIN_LEASES, idleTimeoutMillis: 5_000 },
          { role: "lore_maintenance" },
        ),
        admin: new pg.Pool({ connectionString: databaseUrl, max: 4 }),
      };
      return databases;
    },
    async close() {
      if (!databases) return;
      await Promise.allSettled([
        databases.request.close(),
        databases.maintenance.close(),
        databases.admin.end(),
      ]);
      databases = undefined;
    },
  };
}

/**
 * Check a Unit's Memories: one Alice Memory per record, one Bob Memory per
 * tripwire, and a vector in the benchmark embedding space for every chunk of
 * Alice's. Returns the chunk count, or why it fails.
 */
export async function memoryCoverage(
  admin: pg.Pool,
  workspaceId: string,
  unit: EvalUnit,
): Promise<{ chunks: number } | { problem: string }> {
  const { rows } = await admin.query<{
    alice: string;
    bob: string;
    chunks: string;
    embedded: string;
  }>(
    `SELECT
       (SELECT count(*) FROM memories WHERE workspace_id = $1 AND owner_user_id = $2)::text AS alice,
       (SELECT count(*) FROM memories WHERE workspace_id = $1 AND owner_user_id = $3)::text AS bob,
       count(c.id)::text AS chunks,
       count(e.chunk_id)::text AS embedded
     FROM memory_chunks c
     JOIN memories m ON m.id = c.memory_id AND m.owner_user_id = $2
     LEFT JOIN LATERAL (
       SELECT e.chunk_id FROM memory_chunk_embeddings e
       JOIN embedding_generations g ON g.id = e.generation_id
       WHERE e.chunk_id = c.id AND g.embedding_provider = $4 AND g.embedding_model = $5
         AND g.embedding_dimensions = $6 AND g.embedding_revision = $7
       LIMIT 1
     ) e ON true
     WHERE c.workspace_id = $1`,
    [
      workspaceId,
      ALICE,
      BOB,
      EMBEDDING_SPACE.provider,
      EMBEDDING_SPACE.model,
      EMBEDDING_SPACE.dimensions,
      EMBEDDING_SPACE.revision,
    ],
  );
  const row = rows[0];
  const [alice, bob, chunks, embedded] = [row?.alice, row?.bob, row?.chunks, row?.embedded].map(
    Number,
  );
  if (alice !== unit.records.length)
    return { problem: `${alice} of ${unit.records.length} records` };
  if (bob !== unit.tripwires.length)
    return { problem: `${bob} of ${unit.tripwires.length} tripwires` };
  if (!chunks || embedded !== chunks)
    return { problem: `${embedded} of ${chunks} chunks embedded` };
  return { chunks: chunks ?? 0 };
}

/**
 * Seed every Unit not already ready, once across sandboxes, and check every
 * Workspace before it is used. A system supplies how to write one Unit and how
 * to check one; this owns the rest:
 *
 * - A ready Workspace is reused only after `coverage` passes again.
 * - Each Unit is seeded under an advisory lock, taken in Workspace order so two
 *   batches never wait on each other; whoever waits finds the Unit ready and
 *   reuses it. Only an unlocked building Workspace counts as a stopped seed.
 * - Seeding is bound by round trips (about 107 ms to Railway), so embedding jobs
 *   drain while later Memories are still being written, as a deployment's worker
 *   does. `seedUnit` writes a Unit's records in order, so their updated_at order,
 *   which ranking uses to break ties, is the same every seed.
 * - The final drain waits for this batch's jobs, pending or leased by another
 *   sandbox, and a Unit is marked ready only when `coverage` passes.
 */
export async function seedUnits(input: {
  context: SystemContext;
  units: EvalUnit[];
  databases: SystemDatabases;
  provider: EmbeddingProvider;
  counters: EmbeddingCacheCounters;
  seedUnit(unit: EvalUnit, workspaceId: string): Promise<void>;
  coverage(unit: EvalUnit, workspaceId: string): Promise<{ chunks: number } | { problem: string }>;
}): Promise<IngestOutcome> {
  const { context, databases, provider, counters } = input;
  const { admin, maintenance } = databases;
  await admin.query(
    "INSERT INTO users (id, display_name) VALUES ($1, 'Alice eval'), ($2, 'Bob eval') ON CONFLICT (id) DO NOTHING",
    [ALICE, BOB],
  );
  const outcome: IngestOutcome = { seeded: 0, reused: 0, verifiedChunks: 0 };
  const reuse = async (unit: EvalUnit, workspaceId: string) => {
    const checked = await input.coverage(unit, workspaceId);
    if ("problem" in checked) {
      throw new Error(
        `Workspace ${workspaceId} for ${unit.key} is marked ready but holds ${checked.problem}`,
      );
    }
    outcome.reused += 1;
    outcome.verifiedChunks += checked.chunks;
  };
  const nameOf = async (workspaceId: string) =>
    (
      await admin.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [
        workspaceId,
      ])
    ).rows[0]?.name;
  const unready: EvalUnit[] = [];
  for (const unit of input.units) {
    const workspaceId = context.workspaceIdFor(unit);
    if ((await nameOf(workspaceId)) === `eval ready ${unit.key}`) {
      await reuse(unit, workspaceId);
    } else {
      unready.push(unit);
    }
  }
  if (!unready.length) return outcome;
  const locker = await admin.connect();
  const held: string[] = [];
  try {
    const pending: EvalUnit[] = [];
    for (const unit of [...unready].sort((left, right) =>
      context.workspaceIdFor(left).localeCompare(context.workspaceIdFor(right)),
    )) {
      const workspaceId = context.workspaceIdFor(unit);
      await locker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [workspaceId]);
      held.push(workspaceId);
      const name = await nameOf(workspaceId);
      if (name === `eval ready ${unit.key}`) {
        await reuse(unit, workspaceId);
        continue;
      }
      if (name) await admin.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      pending.push(unit);
    }
    let seeded = 0;
    const drain = createEmbeddingMaintenance(maintenance, { embeddingProviders: [provider] });
    let seeding = true;
    let drainFailure: unknown;
    const background = Promise.all(
      Array.from({ length: DRAIN_LEASES }, async () => {
        while (seeding && drainFailure === undefined) {
          try {
            const result = await drain.run();
            if (result.status === "dead") {
              throw new Error(`Embedding job ${result.jobId ?? "unknown"} ended as dead`);
            }
            if (result.status !== "complete") await sleep(500);
          } catch (error) {
            drainFailure = error;
          }
        }
      }),
    );
    try {
      await parallel(pending, SEED_UNITS_AT_ONCE, async (unit) => {
        const workspaceId = context.workspaceIdFor(unit);
        await admin.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [
          workspaceId,
          `eval building ${unit.key}`,
        ]);
        await admin.query(
          "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
          [workspaceId, ALICE, BOB],
        );
        await input.seedUnit(unit, workspaceId);
        if (++seeded % 25 === 0) context.log(`seeded ${seeded}/${pending.length} units`);
      });
    } finally {
      seeding = false;
      await background;
    }
    if (drainFailure !== undefined) throw drainFailure;
    if (pending.length) {
      await drainEmbeddingMaintenance({
        run: () => drain.run(),
        concurrency: DRAIN_LEASES,
        pendingJobCount: async () =>
          Number(
            (
              await admin.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM memory_embedding_jobs
                 WHERE workspace_id = ANY($1::uuid[]) AND status IN ('pending', 'processing')`,
                [pending.map((unit) => context.workspaceIdFor(unit))],
              )
            ).rows[0]?.count ?? 0,
          ),
        onProgress: (completed, round) => {
          if (completed % 1_000 < round) context.log(`embedded ${completed} Memories`);
        },
      });
      if (counters.failures) throw new Error("Embedding failed during ingestion");
      for (const unit of pending) {
        const workspaceId = context.workspaceIdFor(unit);
        // A job can end without a provider failure (a lost lease, a database
        // error); only a Workspace that passes its check is ready.
        const checked = await input.coverage(unit, workspaceId);
        if ("problem" in checked) throw new Error(`Seeding ${unit.key} left ${checked.problem}`);
        await admin.query("UPDATE workspaces SET name = $2 WHERE id = $1", [
          workspaceId,
          `eval ready ${unit.key}`,
        ]);
        outcome.seeded += 1;
        outcome.verifiedChunks += checked.chunks;
      }
    }
  } finally {
    for (const workspaceId of held) {
      await locker.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [workspaceId]);
    }
    locker.release();
  }
  return outcome;
}
