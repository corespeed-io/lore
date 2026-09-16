import assert from "node:assert/strict";
import {
  chunkMemoryContent,
  createMemoryModule,
  type EmbeddingProvider,
  type MemoryStorageContext,
  type PostgresDatabase,
  type QueryPlanningProvider,
  type RerankingProvider,
} from "@corespeed/lore-core";
import { createEpisodeEvidenceModule } from "@corespeed/lore-core/episodes";

const calls: string[] = [];
const embeddingProvider: EmbeddingProvider = {
  provider: "host-vector-service",
  model: "models/private-index-7",
  revision: "host-protocol-2",
  dimensions: 8,
  async embed(texts, task) {
    calls.push(`embed:${task}`);
    return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
  },
};
const queryPlanningProvider: QueryPlanningProvider = {
  async plan() {
    calls.push("plan");
    return ["harbor navigation"];
  },
};
const rerankingProvider: RerankingProvider = {
  async rerank({ documents }) {
    return documents.map(({ id }) => ({ documentId: id, score: 1 }));
  },
};
const database: PostgresDatabase = {
  transaction: (use) => use({ query: async () => ({ rows: [] }) }),
};
const options = { embeddingProvider, queryPlanningProvider, rerankingProvider };
const storage: MemoryStorageContext = {
  database,
  partitionId: "20000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000001",
};

assert.equal(chunkMemoryContent("Host-owned providers preserve the engine boundary.").length, 1);
for (const module of [
  createMemoryModule(storage, options),
  createEpisodeEvidenceModule(storage, options),
]) {
  calls.length = 0;
  assert.deepEqual(await module.search({ query: "tidal charts" }), []);
  assert.ok(calls.includes("plan"));
  assert.ok(calls.includes("embed:query"));
}
console.log("independent core consumer passed");
