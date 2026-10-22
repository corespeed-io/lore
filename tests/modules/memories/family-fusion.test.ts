import type { EmbeddingTask } from "@corespeed/lore-core";
import { createEmbeddingMaintenance } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { createMemoryTestContext } from "../../support/memory-context";

// Search fuses its channels in two steps: the lexical channels into one lexical
// ranking, then that ranking and the semantic channel, one vote each. A Memory only
// the semantic channel finds must not be outvoted by one that several near-identical
// lexical channels all find, only because there are more of them.

const QUERY = "failed deploy rollback";
const KEYWORDS = "Failed deploy rollback drills are scheduled quarterly.";
const MEANING = "部署失败后先回滚，再排查原因。";

/** Two directions: the query and MEANING share one, KEYWORDS has the other. */
const provider = {
  provider: "fixture",
  model: "fixture-embedding-v1",
  dimensions: 1024 as const,
  revision: "fixture-v1",
  async embed(texts: string[], _task: EmbeddingTask) {
    return texts.map((text) =>
      Array.from({ length: 1024 }, (_, index) => (index === (text === KEYWORDS ? 1 : 0) ? 1 : 0)),
    );
  },
};

test("a semantic-only match scores as one lexical-only match, not below it", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database, { embeddingProvider: provider });
  const keywords = await memories.remember(context.alice, { content: KEYWORDS });
  const meaning = await memories.remember(context.alice, { content: MEANING });
  const maintenance = createEmbeddingMaintenance(context.maintenanceDatabase, {
    embeddingProviders: [provider],
  });
  while ((await maintenance.run()).status === "complete") {
    // Embed both Memories.
  }

  const results = await memories.search(context.alice, { query: QUERY });
  const score = (id: string) => results.find((result) => result.memory.id === id)?.score;
  // KEYWORDS matches three lexical channels and is orthogonal to the query, past the
  // distance threshold; MEANING matches no lexical channel and is the query's
  // nearest chunk. Each is first in the one family that finds it.
  expect(score(keywords.id)).toBeCloseTo(1 / 61, 10);
  expect(score(meaning.id)).toBeCloseTo(1 / 61, 10);
  await context.close();
});
