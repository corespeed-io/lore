import { expect, test } from "vitest";
import { createMemoryMaintenanceModule } from "@/lib/maintenance";
import { createMemoryModule, type EmbeddingTask } from "@/lib/memory";
import type { BenchmarkReaderProvider } from "../scripts/lib/benchmark-reader";
import { memoryAgentBenchSubstringExactMatch } from "../scripts/lib/memoryagentbench";
import { createMemoryTestContext } from "./support/memory-context";

test("MemoryAgentBench conflict pipeline preserves sequence and rejects private tripwires", async () => {
  const testContext = await createMemoryTestContext();
  const vector = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));
  const embeddingProvider = {
    provider: "fixture",
    model: "fixture-conflict",
    dimensions: 1024 as const,
    revision: "fixture-v1",
    async embed(texts: string[], _task: EmbeddingTask) {
      return texts.map(() => vector);
    },
  };
  const writer = createMemoryModule(testContext.database, { embeddingProvider });
  const visible = await writer.remember(testContext.alice, {
    content: "0. The capital is Paris.\n1. The capital is Rome.",
    scope: "private",
    metadata: { benchmark: "MemoryAgentBench", corpusKey: "fixture", source: "conflict" },
  });
  const forbidden = await writer.remember(testContext.bob, {
    content: "Private answer tripwire: Answer: Paris.",
    scope: "private",
    metadata: { benchmark: "MemoryAgentBench", corpusKey: "fixture", source: "conflict" },
  });
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider,
  });
  while ((await maintenance.run()).status === "complete") {
    // Drain deterministic fixture jobs.
  }
  const retrieved = await createMemoryModule(testContext.database, {
    embeddingProvider,
    evidenceTopChunks: 2,
  }).search(testContext.alice, {
    query: "What is the latest capital?",
    metadataFilter: { benchmark: "MemoryAgentBench", corpusKey: "fixture", source: "conflict" },
    limit: 5,
  });
  const reader: BenchmarkReaderProvider = {
    provider: "fixture",
    model: "fixture-reader",
    revision: "fixture-v1",
    profile: "lore-portable-deterministic-v2",
    transport: "openai-chat-completions",
    instruction: "Newer fact numbers win",
    maximumContextCharacters: 10_000,
    decoding: { temperature: 0, topP: null, topK: null, maximumOutputTokens: 128 },
    supportsQuestionImages: true,
    async answer(input) {
      expect(input.evidence.map((item) => item.id)).toEqual([visible.id]);
      expect(input.evidence[0]?.text).toContain("0. The capital is Paris");
      expect(input.evidence[0]?.text).toContain("1. The capital is Rome");
      return { text: "Answer: Rome.", inputTokens: 20, outputTokens: 3, totalTokens: 23 };
    },
  };
  const answer = await reader.answer({
    question: "What is the latest capital?",
    evidence: retrieved.map((result) => ({ id: result.memory.id, text: result.evidence })),
  });

  expect(retrieved.map((result) => result.memory.id)).not.toContain(forbidden.id);
  expect(memoryAgentBenchSubstringExactMatch(answer.text, ["Rome"])).toBe(true);
  await testContext.close();
});
