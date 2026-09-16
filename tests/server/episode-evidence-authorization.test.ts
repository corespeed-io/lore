import type { EmbeddingProvider } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import {
  createEpisodeEvidenceModule,
  EpisodeEvidenceAccessDeniedError,
} from "@/modules/episodes/evidence";
import { createObservationModule } from "@/modules/episodes/service";
import { createMemoryTestContext } from "../support/memory-context";

test("OSS rechecks Episode indexing authority after embedding and for verification", async () => {
  const context = await createMemoryTestContext();
  const episode = await createObservationModule(context.database).record(context.alice, {
    kind: "workflow",
    scope: "shared",
    observations: [{ kind: "event", content: "Evidence whose owner loses access mid-index." }],
  });
  let embedded = false;
  const embeddingProvider: EmbeddingProvider = {
    provider: "test",
    model: "revocation-fixture",
    revision: "1",
    dimensions: 1024,
    async embed(texts) {
      embedded = true;
      await context.suspendMembership(context.alice);
      return texts.map(() => Array.from({ length: 1024 }, (_, index) => Number(index === 0)));
    },
  };
  const evidence = createEpisodeEvidenceModule(context.database, { embeddingProvider });

  // A shared Episode can be read by Bob, but verifying its index is an owner write operation.
  await expect(
    evidence.index(context.bob, { episodeId: episode.id, mode: "verify" }),
  ).rejects.toBeInstanceOf(EpisodeEvidenceAccessDeniedError);
  expect(embedded).toBe(false);

  await expect(evidence.index(context.alice, { episodeId: episode.id })).rejects.toBeInstanceOf(
    EpisodeEvidenceAccessDeniedError,
  );
  expect(embedded).toBe(true);
  const persisted = await context.adminDatabase.transaction((transaction) =>
    transaction.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM episode_evidence_chunk_embeddings WHERE episode_id = $1",
      [episode.id],
    ),
  );
  expect(persisted.rows).toEqual([{ count: "0" }]);
});
