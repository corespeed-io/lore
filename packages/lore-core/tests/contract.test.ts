import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { expect, test } from "vitest";
import {
  createMemoryModule,
  type EmbeddingProvider,
  type MemoryStorageContext,
  type QueryPlanningProvider,
  type RerankingProvider,
} from "../src/index";
import {
  createDeterministicTestEmbeddingProvider,
  type MemoryCoreContractFixture,
  runMemoryCoreContractSuite,
  testDatabase,
} from "../src/testing";

/**
 * The engine's own contract run uses lore oss's migration chain and identity
 * model: users/workspaces/memberships rows satisfy the membership-consulting
 * RLS policy bodies. A host with different policy bodies (for example HaaS's
 * pure-GUC comparisons) points the same suite at its own chain and seeds
 * nothing but actor ids.
 */

const ALICE = "10000000-0000-4000-8000-000000000001";
const BOB = "10000000-0000-4000-8000-000000000002";
const CAROL = "10000000-0000-4000-8000-000000000003";
const OPERATIONS = "20000000-0000-4000-8000-000000000001";
const RESEARCH = "20000000-0000-4000-8000-000000000002";

const migrationsUrl = new URL("../../../db/migrations/", import.meta.url);

async function createLoreFixture(): Promise<MemoryCoreContractFixture> {
  const postgres = new PGlite({ extensions: { pg_trgm, vector } });
  await postgres.waitReady;
  const migrationIds = (await readdir(migrationsUrl))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migrationId of migrationIds) {
    await postgres.exec(await readFile(new URL(migrationId, migrationsUrl), "utf8"));
  }
  await postgres.query("INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4), ($5, $6)", [
    ALICE,
    "Alice",
    BOB,
    "Bob",
    CAROL,
    "Carol",
  ]);
  await postgres.query("INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)", [
    OPERATIONS,
    "Operations",
    RESEARCH,
    "Research",
  ]);
  await postgres.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [OPERATIONS, ALICE, BOB],
  );
  await postgres.query(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [RESEARCH, CAROL],
  );
  function storageContext(partitionId: string, ownerId: string): MemoryStorageContext {
    return {
      partitionId,
      ownerId,
      database: testDatabase(postgres, async (transaction) => {
        await transaction.query("SET LOCAL ROLE lore_app");
        await transaction.query(
          `SELECT set_config('lore.workspace_id', $1, true),
                  set_config('lore.user_id', $2, true),
                  set_config('lore.agent_id', '', true)`,
          [partitionId, ownerId],
        );
      }),
    };
  }
  let closePromise: Promise<void> | undefined;
  return {
    database: testDatabase(postgres, async (transaction) => {
      await transaction.query("SET LOCAL ROLE lore_app");
    }),
    maintenanceDatabase: testDatabase(postgres, async (transaction) => {
      await transaction.query("SET LOCAL ROLE lore_maintenance");
    }),
    alice: storageContext(OPERATIONS, ALICE),
    bob: storageContext(OPERATIONS, BOB),
    carol: storageContext(RESEARCH, CAROL),
    close: () => {
      closePromise ??= postgres.close();
      return closePromise;
    },
  };
}

runMemoryCoreContractSuite(createLoreFixture, {
  embeddingDimensions: 1024,
  defaultMemoryScope: "shared",
});

test("host-defined embedding and method-only planning/reranking drive real retrieval", async () => {
  const fixture = await createLoreFixture();
  try {
    const embeddingCalls: Parameters<EmbeddingProvider["embed"]>[] = [];
    const planningCalls: Parameters<QueryPlanningProvider["plan"]>[0][] = [];
    const rerankingCalls: Parameters<RerankingProvider["rerank"]>[0][] = [];
    const customEmbedding = createDeterministicTestEmbeddingProvider(1024, {
      provider: "host-vector-service",
      model: "models/private-index-7",
      revision: "host-protocol-2",
    });
    const embeddingProvider: EmbeddingProvider = {
      ...customEmbedding,
      async embed(texts, task) {
        embeddingCalls.push([texts, task]);
        return customEmbedding.embed(texts, task);
      },
    };
    const queryPlanningProvider: QueryPlanningProvider = {
      async plan(input) {
        planningCalls.push(input);
        return ["harbor"];
      },
    };
    const rerankingProvider: RerankingProvider = {
      async rerank(input) {
        rerankingCalls.push(input);
        return input.documents
          .map(({ id, text }) => ({
            documentId: id,
            score: text.includes("observatory") ? 0.9 : 0.1,
          }))
          .sort((left, right) => right.score - left.score);
      },
    };
    const memories = createMemoryModule(fixture.alice, {
      embeddingProvider,
      queryPlanningProvider,
      rerankingProvider,
    });
    const observatory = await memories.remember({
      content: "The harbor observatory opens in the morning.",
    });
    await memories.remember({
      content: "The harbor station opens in the evening.",
    });

    const results = await memories.search({ query: "stargazing", limit: 1 });

    expect(planningCalls).toEqual([{ query: "stargazing", maxQueries: 2 }]);
    expect(embeddingCalls).toEqual([[["stargazing", "harbor"], "query"]]);
    expect(rerankingCalls).toHaveLength(1);
    expect(rerankingCalls[0]?.documents).toHaveLength(2);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ memory: { id: observatory.id }, rerankScore: 0.9 });
  } finally {
    await fixture.close();
  }
});
