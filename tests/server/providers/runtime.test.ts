import type { MemoryModuleOptions } from "@corespeed/lore-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const numericOptions = {
  LORE_EVIDENCE_NEIGHBOR_CHUNKS: ["evidenceNeighborChunks", 0, 0, 2, true],
  LORE_EVIDENCE_TOP_CHUNKS: ["evidenceTopChunks", 1, 1, 5, true],
  LORE_RETRIEVAL_FEEDBACK_QUERIES: ["retrievalFeedbackQueries", 0, 0, 3, true],
  LORE_QUERY_PLANNER_MAX_QUERIES: ["queryPlannerMaxQueries", 3, 1, 5, true],
  LORE_RETRIEVAL_RECENCY_WEIGHT: ["retrievalRecencyWeight", 0, 0, 1, false],
  LORE_RERANK_MIN_SCORE: ["rerankMinimumScore", 0, 0, 1, false],
  LORE_RERANK_DIVERSITY_LAMBDA: ["rerankDiversityLambda", 1, 0, 1, false],
  LORE_RERANK_WEIGHT: ["rerankWeight", 1, 0, 1, false],
  LORE_SEMANTIC_DISTANCE_THRESHOLD: ["semanticDistanceThreshold", 0.5, 0, 2, false],
} satisfies Record<string, [keyof MemoryModuleOptions, number, number, number, boolean]>;

beforeEach(() => {
  for (const name of Object.keys(numericOptions)) vi.stubEnv(name, undefined);
  vi.stubEnv("LORE_RERANK_CANDIDATE_LIMIT", undefined);
  vi.stubEnv("LORE_ENTITY_ALIAS_RECALL", undefined);
  vi.stubEnv("LORE_EMBEDDING_PROVIDER", "ollama");
  vi.stubEnv("LORE_EMBEDDING_MODEL", "qwen3-embedding:0.6b");
  vi.stubEnv("LORE_EMBEDDING_DIMENSIONS", undefined);
  vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  vi.stubEnv("LORE_QUERY_PLANNER_PROVIDER", undefined);
  vi.stubEnv("LORE_RERANK_PROVIDER", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

test("runtime initializes providers lazily once and keeps maintenance notifications request-scoped", async () => {
  vi.resetModules();
  vi.stubEnv("LORE_QUERY_PLANNER_PROVIDER", "unsupported");
  vi.stubEnv("LORE_RERANK_PROVIDER", "unsupported");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { getRuntimeMemoryModuleOptions } = await import("@/server/providers/runtime");
  expect(warn).not.toHaveBeenCalled();

  const firstNotifier = { notify: vi.fn() };
  const first = getRuntimeMemoryModuleOptions({ maintenanceNotifier: firstNotifier });
  expect(first.embeddingProvider).toMatchObject({
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
  });
  expect(first.queryPlanningProvider).toBeUndefined();
  expect(first.rerankingProvider).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(2);

  vi.stubEnv("LORE_EMBEDDING_MODEL", "a-different-model");
  vi.stubEnv("LORE_QUERY_PLANNER_PROVIDER", "ollama");
  vi.stubEnv("LORE_QUERY_PLANNER_MODEL", "qwen3.5:4b");
  vi.stubEnv("LORE_RERANK_PROVIDER", "vllm");
  vi.stubEnv("LORE_RERANK_MODEL", "reranker");
  const secondNotifier = { notify: vi.fn() };
  const second = getRuntimeMemoryModuleOptions({ maintenanceNotifier: secondNotifier });
  expect(second.embeddingProvider).toBe(first.embeddingProvider);
  expect(second.queryPlanningProvider).toBeUndefined();
  expect(second.rerankingProvider).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(2);

  first.maintenanceNotifier?.notify({ jobId: "first-job" });
  second.maintenanceNotifier?.notify({ jobId: "second-job" });
  expect(firstNotifier.notify).toHaveBeenCalledExactlyOnceWith({ jobId: "first-job" });
  expect(secondNotifier.notify).toHaveBeenCalledExactlyOnceWith({ jobId: "second-job" });
  expect(getRuntimeMemoryModuleOptions().maintenanceNotifier).toBeUndefined();
});

test.each(Object.entries(numericOptions))(
  "%s preserves defaults, numeric bounds, and invalid-value warnings",
  async (name, [key, fallback, minimum, maximum, integer]) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getRuntimeMemoryModuleOptions } = await import("@/server/providers/runtime");
    const cases: [string | undefined, number, boolean][] = [
      [undefined, fallback, false],
      ["", fallback, key === "evidenceTopChunks"],
      ["  ", fallback, key === "evidenceTopChunks"],
      [String(minimum), minimum, false],
      [String(maximum), maximum, false],
      ["NaN", fallback, true],
      ["Infinity", fallback, true],
      ["-Infinity", fallback, true],
      [String(minimum - 1), fallback, true],
      [String(maximum + 1), fallback, true],
      [integer ? "1.5" : "0.5", integer ? fallback : 0.5, integer],
    ];
    for (const [raw, expected, shouldWarn] of cases) {
      vi.stubEnv(name, raw);
      warn.mockClear();
      expect(getRuntimeMemoryModuleOptions()[key], `${name}=${String(raw)}`).toBe(expected);
      expect(warn).toHaveBeenCalledTimes(shouldWarn ? 1 : 0);
      if (shouldWarn) expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
    }
  },
);

test("rerank candidate limits clamp positive integers and silently default other values", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { getRuntimeMemoryModuleOptions } = await import("@/server/providers/runtime");
  const cases: [string | undefined, number][] = [
    [undefined, 50],
    ["", 50],
    ["  ", 50],
    ["0", 50],
    ["-1", 50],
    ["1.5", 50],
    ["NaN", 50],
    ["Infinity", 50],
    ["1", 1],
    ["200", 200],
    ["201", 200],
  ];
  for (const [raw, expected] of cases) {
    vi.stubEnv("LORE_RERANK_CANDIDATE_LIMIT", raw);
    expect(getRuntimeMemoryModuleOptions().rerankCandidateLimit).toBe(expected);
  }
  expect(warn).not.toHaveBeenCalled();
});
