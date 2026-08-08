import { expect, test } from "vitest";
import { evaluateLongMemEvalV2Answer } from "@/lib/answer-evaluation";
import { createMemoryMaintenanceModule } from "@/lib/maintenance";
import { createMemoryModule, type EmbeddingTask } from "@/lib/memory";
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
  const writer = createMemoryModule(testContext.database, { embeddingProvider });
  const expected = await writer.remember(testContext.alice, {
    content: "Trajectory evidence: open Reports first, then navigate to Problems.",
    scope: "private",
    metadata: { benchmark: "LongMemEval-V2", corpusKey: "fixture", questionIds: ["q1"] },
  });
  await writer.remember(testContext.alice, {
    content: "Unrelated trajectory for another question.",
    scope: "private",
    metadata: { benchmark: "LongMemEval-V2", corpusKey: "fixture", questionIds: ["q2"] },
  });
  const forbidden = await writer.remember(testContext.bob, {
    content: "Private answer tripwire: Reports;Problems.",
    scope: "private",
    metadata: { benchmark: "LongMemEval-V2", corpusKey: "fixture", questionIds: ["q1"] },
  });
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider,
  });
  while ((await maintenance.run()).status === "complete") {
    // Drain the three deterministic jobs.
  }
  const results = await createMemoryModule(testContext.database, {
    embeddingProvider,
    semanticDistanceThreshold: 0.5,
  }).search(testContext.alice, {
    query: "Which two modules are used, in order?",
    metadataFilter: { benchmark: "LongMemEval-V2", corpusKey: "fixture", questionIds: ["q1"] },
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
      expect(input.evidence.map((evidence) => evidence.id)).toEqual([expected.id]);
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
    evidence: results.map((result) => ({ id: result.memory.id, text: result.evidence })),
  });
  const evaluated = evaluateLongMemEvalV2Answer({
    prediction: answer.text,
    reference: "Reports;Problems",
    evaluator:
      "norm_phrase_set_match_ordered|lower=true|normalize_hyphen=true|strip_punct=true|separators=;|require_non_empty=true",
  });

  expect(results.map((result) => result.memory.id)).not.toContain(forbidden.id);
  expect(evaluated).toMatchObject({ correct: true, requiresJudge: false });
  await testContext.close();
});
