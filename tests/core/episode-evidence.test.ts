import type { EmbeddingTask } from "@corespeed/lore-core";
import { EPISODE_EVIDENCE_INDEX_REVISION } from "@corespeed/lore-core/episodes";
import { expect, test } from "vitest";
import {
  createEpisodeEvidenceModule,
  EpisodeEvidenceAccessDeniedError,
} from "../../src/modules/episodes/evidence";
import { createObservationModule } from "../../src/modules/episodes/service";
import { createMemoryTestContext } from "../support/memory-context";

function fixtureVector(index: number): number[] {
  return Array.from({ length: 1024 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
}

test("Episode evidence indexes an oversized raw trajectory without inventing canonical Memories", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const evidence = createEpisodeEvidenceModule(testContext.database);
  const content = `${"state tree filler ".repeat(2_100)} needle-zebracode final state`;
  expect(Array.from(content).length).toBeGreaterThan(32_000);

  const episode = await observations.record(testContext.alice, {
    kind: "workflow",
    observations: [
      {
        kind: "event",
        content,
        metadata: {
          benchmark: "LongMemEval-V2",
          corpusKey: "fixture",
          trajectoryId: "trajectory-a",
        },
      },
    ],
  });
  const indexed = await evidence.index(testContext.alice, { episodeId: episode.id });

  expect(indexed).toMatchObject({
    episodeId: episode.id,
    observationCount: 1,
    embeddedChunkCount: 0,
    indexRevision: EPISODE_EVIDENCE_INDEX_REVISION,
  });
  expect(indexed.chunkCount).toBeGreaterThan(1);
  expect(indexed.sourceCharacters).toBe(Array.from(content).length);
  await expect(
    evidence.search(testContext.alice, {
      query: "needle-zebracode",
      groupMetadataKey: "trajectoryId",
      sourceKeys: ["trajectory-a"],
    }),
  ).resolves.toMatchObject([
    {
      sourceKey: "trajectory-a",
      episodeIds: [episode.id],
      metadata: { trajectoryId: "trajectory-a" },
    },
  ]);
  await expect(
    evidence.search(testContext.bob, {
      query: "needle-zebracode",
      groupMetadataKey: "trajectoryId",
      sourceKeys: ["trajectory-a"],
    }),
  ).resolves.toEqual([]);
  await expect(
    evidence.search(testContext.carol, {
      query: "needle-zebracode",
      groupMetadataKey: "trajectoryId",
      sourceKeys: ["trajectory-a"],
    }),
  ).resolves.toEqual([]);
  await expect(
    testContext.adminDatabase.transaction((transaction) =>
      transaction.query<{ count: string }>("SELECT count(*)::text AS count FROM memories"),
    ),
  ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  await testContext.close();
});

test("Episode evidence applies source scope and RLS before semantic top-k", async () => {
  const testContext = await createMemoryTestContext();
  const embeddingTasks: EmbeddingTask[] = [];
  const embeddingProvider = {
    provider: "fixture",
    model: "episode-evidence-v1",
    dimensions: 1024 as const,
    revision: "fixture-v1",
    async embed(texts: string[], task: EmbeddingTask) {
      embeddingTasks.push(task);
      return texts.map((text) => (/cat|feline/i.test(text) ? fixtureVector(0) : fixtureVector(1)));
    },
  };
  const observations = createObservationModule(testContext.database);
  const evidence = createEpisodeEvidenceModule(testContext.database, { embeddingProvider });
  const visible = await observations.record(testContext.alice, {
    kind: "workflow",
    scope: "shared",
    observations: [
      {
        kind: "event",
        content: "The feline sleeps beside the warm terminal.",
        metadata: { trajectoryId: "visible-trajectory" },
      },
    ],
  });
  const forbidden = await observations.record(testContext.bob, {
    kind: "workflow",
    observations: [
      {
        kind: "event",
        content: "The classified feline record contains the forbidden answer.",
        metadata: { trajectoryId: "forbidden-tripwire" },
      },
    ],
  });
  await evidence.index(testContext.alice, { episodeId: visible.id });
  await evidence.index(testContext.bob, { episodeId: forbidden.id });

  const results = await evidence.search(testContext.alice, {
    query: "cat",
    limit: 10,
    groupMetadataKey: "trajectoryId",
    sourceKeys: ["visible-trajectory", "forbidden-tripwire"],
  });
  expect(results.map((result) => result.sourceKey)).toEqual(["visible-trajectory"]);
  expect(embeddingTasks).toContain("document");
  expect(embeddingTasks.at(-1)).toBe("query");
  await expect(
    evidence.search(testContext.alice, {
      query: "cat",
      groupMetadataKey: "trajectoryId",
      sourceKeys: ["forbidden-tripwire"],
    }),
  ).resolves.toEqual([]);
  await testContext.close();
});

test("Episode evidence reranking ranks by validated score whatever order the provider returns", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const scores = new Map([
    ["trajectory-alpha", 0.2],
    ["trajectory-beta", 0.9],
    ["trajectory-gamma", 0.5],
  ]);
  const episode = await observations.record(testContext.alice, {
    kind: "workflow",
    observations: [...scores.keys()].map((trajectoryId) => ({
      kind: "event" as const,
      content: `The orbital burn report for ${trajectoryId}.`,
      metadata: { trajectoryId },
    })),
  });
  await createEpisodeEvidenceModule(testContext.database).index(testContext.alice, {
    episodeId: episode.id,
  });
  const search = (ordering: "ascending" | "descending") =>
    createEpisodeEvidenceModule(testContext.database, {
      rerankingProvider: {
        async rerank(input) {
          const scored = input.documents.map((document) => ({
            documentId: document.id,
            score: scores.get(document.id) ?? 0,
          }));
          const direction = ordering === "ascending" ? 1 : -1;
          return scored.sort((left, right) => direction * (left.score - right.score));
        },
      },
    }).search(testContext.alice, {
      query: "orbital burn report",
      groupMetadataKey: "trajectoryId",
      limit: 3,
    });

  const unsorted = await search("ascending");
  const sorted = await search("descending");

  expect(unsorted.map((result) => result.sourceKey)).toEqual([
    "trajectory-beta",
    "trajectory-gamma",
    "trajectory-alpha",
  ]);
  expect(unsorted.map((result) => result.rerankScore)).toEqual([0.9, 0.5, 0.2]);
  expect(sorted).toEqual(unsorted);
  await testContext.close();
});

test("Episode evidence verification rejects a corrupted derived index", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const evidence = createEpisodeEvidenceModule(testContext.database);
  const episode = await observations.record(testContext.alice, {
    kind: "workflow",
    observations: [{ kind: "event", content: "Exact ordered trajectory evidence." }],
  });
  await evidence.index(testContext.alice, { episodeId: episode.id });
  await expect(
    evidence.index(testContext.alice, { episodeId: episode.id, mode: "verify" }),
  ).resolves.toMatchObject({ chunkCount: 1 });

  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      "UPDATE episode_evidence_chunks SET content = 'corrupted' WHERE episode_id = $1",
      [episode.id],
    ),
  );
  await expect(
    evidence.index(testContext.alice, { episodeId: episode.id, mode: "verify" }),
  ).rejects.toThrow("failed exact reconstruction validation");
  await testContext.close();
});

test("Only the Episode owner or an authorized owner Agent may build derived evidence", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const evidence = createEpisodeEvidenceModule(testContext.database);
  const episode = await observations.record(testContext.alice, {
    kind: "workflow",
    scope: "shared",
    observations: [{ kind: "event", content: "Shared but owner-controlled evidence." }],
  });

  await expect(evidence.index(testContext.bob, { episodeId: episode.id })).rejects.toBeInstanceOf(
    EpisodeEvidenceAccessDeniedError,
  );
  await evidence.index(testContext.alice, { episodeId: episode.id });
  await expect(observations.forget(testContext.alice, episode.id)).resolves.toBe(true);
  await expect(evidence.search(testContext.alice, { query: "owner-controlled" })).resolves.toEqual(
    [],
  );
  await testContext.close();
});
