import type { EmbeddingTask } from "@corespeed/lore-core";
import {
  createEpisodeEvidenceModule,
  createObservationModule,
} from "@corespeed/lore-core/episodes";
import { expect, test } from "vitest";
import { evaluateLongMemEvalV2Answer } from "@/lib/answer-evaluation";
import type { BenchmarkReaderProvider } from "../scripts/lib/benchmark-reader";
import { createMemoryTestContext } from "./support/memory-context";

test("LongMemEval-V2 fixed-reader pipeline keeps haystack filtering and RLS before answering", async () => {
  const testContext = await createMemoryTestContext();
  const vector = (index: number) =>
    Array.from({ length: 1024 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
  const embeddingProvider = {
    provider: "fixture",
    model: "fixture-v2",
    dimensions: 1024 as const,
    revision: "fixture-v1",
    async embed(texts: string[], _task: EmbeddingTask) {
      return texts.map((text) => (/reports|problems|module/i.test(text) ? vector(0) : vector(1)));
    },
  };
  const observations = createObservationModule(testContext.database);
  const evidence = createEpisodeEvidenceModule(testContext.database, {
    embeddingProvider,
    semanticDistanceThreshold: 0.5,
  });
  const expected = await observations.record(testContext.alice, {
    kind: "workflow",
    observations: [
      {
        kind: "event",
        content: "Trajectory evidence: open Reports first, then navigate to Problems.",
        metadata: {
          benchmark: "LongMemEval-V2",
          corpusKey: "fixture",
          trajectoryId: "trajectory-q1",
        },
      },
    ],
  });
  const unrelated = await observations.record(testContext.alice, {
    kind: "workflow",
    observations: [
      {
        kind: "event",
        content: "Unrelated trajectory for another question.",
        metadata: {
          benchmark: "LongMemEval-V2",
          corpusKey: "fixture",
          trajectoryId: "trajectory-q2",
        },
      },
    ],
  });
  const forbidden = await observations.record(testContext.bob, {
    kind: "workflow",
    observations: [
      {
        kind: "event",
        content: "Private answer tripwire: Reports;Problems.",
        metadata: {
          benchmark: "LongMemEval-V2",
          corpusKey: "fixture",
          trajectoryId: "forbidden-tripwire",
        },
      },
    ],
  });
  await evidence.index(testContext.alice, { episodeId: expected.id });
  await evidence.index(testContext.alice, { episodeId: unrelated.id });
  await evidence.index(testContext.bob, { episodeId: forbidden.id });
  const results = await evidence.search(testContext.alice, {
    query: "Which two modules are used, in order?",
    metadataFilter: { benchmark: "LongMemEval-V2", corpusKey: "fixture" },
    groupMetadataKey: "trajectoryId",
    sourceKeys: ["trajectory-q1", "forbidden-tripwire"],
    limit: 5,
  });
  const reader: BenchmarkReaderProvider = {
    provider: "fixture",
    model: "fixture-reader",
    revision: "fixture-v1",
    profile: "lore-portable-deterministic-v2",
    transport: "openai-chat-completions",
    instruction: "Answer from evidence",
    maximumContextCharacters: 10_000,
    decoding: { temperature: 0, topP: null, topK: null, maximumOutputTokens: 128 },
    supportsQuestionImages: true,
    async answer(input) {
      expect(input.evidence.map((evidence) => evidence.id)).toEqual(["trajectory-q1"]);
      expect(input.evidence[0]?.text).toContain("Reports first");
      return {
        text: "\\boxed{Reports;Problems}",
        inputTokens: 20,
        outputTokens: 4,
        totalTokens: 24,
      };
    },
  };
  const answer = await reader.answer({
    question: "Which two modules are used, in order?",
    evidence: results.map((result) => ({ id: result.sourceKey, text: result.evidence })),
  });
  const evaluated = evaluateLongMemEvalV2Answer({
    prediction: answer.text,
    reference: "Reports;Problems",
    evaluator:
      "norm_phrase_set_match_ordered|lower=true|normalize_hyphen=true|strip_punct=true|separators=;|require_non_empty=true",
  });

  expect(results.flatMap((result) => result.episodeIds)).not.toContain(forbidden.id);
  expect(evaluated).toMatchObject({ correct: true, requiresJudge: false });
  await testContext.close();
});
