import { createEmbeddingMaintenance, MEMORY_CHUNKING_REVISION } from "@corespeed/lore-core";
import pg from "pg";
import { createMemoryModule } from "../../../src/modules/memories/service";
import { createPostgresDatabase } from "../../../src/server/database/postgres";
import { createGoogleEmbeddingProvider } from "../../../src/server/providers/embedding/google";
import { strictRetrievalKnobsFromEnvironment } from "../../../src/server/providers/retrieval-knobs";
import { drainEmbeddingMaintenance } from "../shared/embedding-maintenance-drain";
import { cachedEmbeddingProvider } from "./embedding-cache";
import type { EvalStore } from "./store";
import type { EvalCase, EvalSystem, EvalUnit, IngestOutcome, Packet, SystemContext } from "./types";

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

/**
 * Check a Unit's Workspace holds what seeding it promises: one Alice Memory per
 * record, one Bob Memory per tripwire, and a vector in the benchmark embedding
 * space for every chunk of Alice's. Returns the chunk count, or why it fails.
 */
async function coverage(
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

async function parallel<T>(
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

/**
 * The shipped Memory path: every record becomes an Alice-private Memory through the
 * Memory module, embeddings come from leased maintenance, and each question is one
 * Memory search with the deployment's default knobs, limited to its Unit. Bob's
 * private tripwires sit in the same Workspace; a search that returns one fails.
 */
export function memorySearchSystem(options: {
  store: EvalStore;
  geminiApiKey: string;
  limit?: number;
}): EvalSystem {
  const limit = options.limit ?? 10;
  const { provider, counters } = cachedEmbeddingProvider(
    createGoogleEmbeddingProvider(EMBEDDING_SPACE, { apiKey: options.geminiApiKey, maxRetries: 5 }),
    options.store,
  );
  const knobs = strictRetrievalKnobsFromEnvironment({});
  let databases:
    | {
        request: ReturnType<typeof createPostgresDatabase>;
        maintenance: ReturnType<typeof createPostgresDatabase>;
        admin: pg.Pool;
      }
    | undefined;
  const connect = async (databaseUrl: string) => {
    if (!databases) {
      const admin = new pg.Pool({ connectionString: databaseUrl, max: 6 });
      databases = {
        request: createPostgresDatabase({ connectionString: databaseUrl, max: 12 }),
        maintenance: createPostgresDatabase(
          { connectionString: databaseUrl, max: 8 },
          { role: "lore_maintenance" },
        ),
        admin,
      };
    }
    return databases;
  };
  const memories = (request: ReturnType<typeof createPostgresDatabase>) =>
    createMemoryModule(request, {
      ...knobs,
      embeddingDimensions: EMBEDDING_SPACE.dimensions,
      embeddingProvider: provider,
    });

  return {
    id: "memory-search",
    ingestIdentity: () => ({
      system: "memory-search",
      ingestRevision: 1,
      records: "one Alice-private Memory per record; metadata evalUnit, evalKey, evalAnchorKey",
      tripwires: "one Bob-private Memory each, never embedded",
      chunking: MEMORY_CHUNKING_REVISION,
      embedding: EMBEDDING_SPACE,
    }),
    retrievalIdentity: () => ({ limit, knobs, embedding: EMBEDDING_SPACE }),

    async ingest(context: SystemContext, units: EvalUnit[]): Promise<IngestOutcome> {
      const { request, maintenance, admin } = await connect(context.databaseUrl);
      await admin.query(
        "INSERT INTO users (id, display_name) VALUES ($1, 'Alice eval'), ($2, 'Bob eval') ON CONFLICT (id) DO NOTHING",
        [ALICE, BOB],
      );
      const alice = memories(request);
      // Tripwires are written without a provider, so no embedding job exists that Alice cannot see.
      const bob = createMemoryModule(request, {
        ...knobs,
        embeddingDimensions: EMBEDDING_SPACE.dimensions,
      });
      const outcome: IngestOutcome = { seeded: 0, reused: 0, verifiedChunks: 0 };
      const pending: EvalUnit[] = [];
      for (const unit of units) {
        const workspaceId = context.workspaceIdFor(unit);
        const existing = await admin.query<{ name: string }>(
          "SELECT name FROM workspaces WHERE id = $1",
          [workspaceId],
        );
        const name = existing.rows[0]?.name;
        if (name === `eval ready ${unit.key}`) {
          // A ready Workspace is reused only after it is checked again.
          const checked = await coverage(admin, workspaceId, unit);
          if ("problem" in checked) {
            throw new Error(
              `Workspace ${workspaceId} for ${unit.key} is marked ready but holds ${checked.problem}`,
            );
          }
          outcome.reused += 1;
          outcome.verifiedChunks += checked.chunks;
          continue;
        }
        // A seed that stopped part way is disposable: drop it and seed again.
        if (name) await admin.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
        pending.push(unit);
      }
      let seeded = 0;
      await parallel(pending, 6, async (unit) => {
        const workspaceId = context.workspaceIdFor(unit);
        await admin.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [
          workspaceId,
          `eval building ${unit.key}`,
        ]);
        await admin.query(
          "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
          [workspaceId, ALICE, BOB],
        );
        for (const record of unit.records) {
          await alice.remember(
            { workspaceId, userId: ALICE },
            {
              content: record.text,
              scope: "private",
              metadata: {
                evalUnit: unit.key,
                evalKey: record.key,
                ...(record.anchorKey ? { evalAnchorKey: record.anchorKey } : {}),
              },
            },
          );
        }
        for (const [index, tripwire] of unit.tripwires.entries()) {
          await bob.remember(
            { workspaceId, userId: BOB },
            {
              content: tripwire,
              scope: "private",
              metadata: { evalUnit: unit.key, evalTripwire: index },
            },
          );
        }
        if (++seeded % 25 === 0) context.log(`seeded ${seeded}/${pending.length} units`);
      });
      if (pending.length) {
        const drain = createEmbeddingMaintenance(maintenance, { embeddingProviders: [provider] });
        await drainEmbeddingMaintenance({
          run: () => drain.run(),
          concurrency: 8,
          pendingJobCount: async () =>
            Number(
              (
                await admin.query<{ count: string }>(
                  "SELECT count(*)::text AS count FROM memory_embedding_jobs WHERE status = 'pending'",
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
          // error); only a Workspace whose every chunk has its vector is ready.
          const checked = await coverage(admin, workspaceId, unit);
          if ("problem" in checked) {
            throw new Error(`Seeding ${unit.key} left ${checked.problem}`);
          }
          await admin.query("UPDATE workspaces SET name = $2 WHERE id = $1", [
            workspaceId,
            `eval ready ${unit.key}`,
          ]);
          outcome.seeded += 1;
          outcome.verifiedChunks += checked.chunks;
        }
      }
      return outcome;
    },

    async retrieve(context: SystemContext, unit: EvalUnit, evalCase: EvalCase): Promise<Packet> {
      const { request } = await connect(context.databaseUrl);
      const failuresBefore = counters.failures;
      const startedAt = performance.now();
      const results = await memories(request).search(
        { workspaceId: context.workspaceIdFor(unit), userId: ALICE },
        { query: evalCase.searchQuery, limit, metadataFilter: { evalUnit: unit.key } },
      );
      const latencyMs = performance.now() - startedAt;
      // The engine quietly falls back to lexical search when the query embedding fails.
      if (counters.failures !== failuresBefore) {
        throw new Error(`${evalCase.id}: the query embedding failed`);
      }
      return {
        latencyMs,
        items: results.map((result) => {
          const metadata = result.memory.metadata as Record<string, unknown>;
          const key = String(metadata.evalAnchorKey ?? metadata.evalKey ?? "");
          return {
            id: metadata.evalTripwire === undefined ? `memory:${key}` : "tripwire",
            text: result.evidence,
            sourceKeys: metadata.evalTripwire === undefined ? [key] : [],
          };
        }),
      };
    },

    usage: () => ({
      embeddingsFromStore: counters.cached,
      embeddingsNew: counters.embedded,
      embeddingRequests: counters.requests,
      embeddingFailures: counters.failures,
    }),

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
