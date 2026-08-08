import { expect, test, vi } from "vitest";
import { createQueryPlanningProviderFromEnvironment } from "@/lib/query-planning/provider-factory";

test("query planning stays disabled unless explicitly configured", () => {
  expect(createQueryPlanningProviderFromEnvironment({})).toBeUndefined();
});

test.each([
  ["an unsupported provider", { LORE_QUERY_PLANNER_PROVIDER: "localai" }],
  ["a missing model", { LORE_QUERY_PLANNER_PROVIDER: "vllm" }],
  [
    "a missing OpenAI key",
    { LORE_QUERY_PLANNER_PROVIDER: "openai", LORE_QUERY_PLANNER_MODEL: "gpt-4.1-mini" },
  ],
  [
    "an insecure OpenAI URL",
    {
      LORE_QUERY_PLANNER_PROVIDER: "openai",
      LORE_QUERY_PLANNER_MODEL: "gpt-test",
      LORE_QUERY_PLANNER_API_KEY: "secret",
      LORE_QUERY_PLANNER_BASE_URL: "http://openai.internal/v1",
    },
  ],
])("query planning degrades safely for %s", (_case, env) => {
  const warnings: string[] = [];

  expect(
    createQueryPlanningProviderFromEnvironment(env, (message) => warnings.push(message)),
  ).toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/^Lore query planning disabled: /);
});

test("query planning accepts Gemini's deployment API key", () => {
  expect(
    createQueryPlanningProviderFromEnvironment({
      LORE_QUERY_PLANNER_PROVIDER: "google",
      LORE_QUERY_PLANNER_MODEL: "gemini-test",
      LORE_QUERY_PLANNER_BASE_URL: "",
      LORE_QUERY_PLANNER_API_KEY: "",
      GEMINI_API_KEY: "secret",
    }),
  ).toMatchObject({ provider: "google", model: "gemini-test" });
});

test("query planning accepts OpenAI's deployment API key", () => {
  expect(
    createQueryPlanningProviderFromEnvironment({
      LORE_QUERY_PLANNER_PROVIDER: "openai",
      LORE_QUERY_PLANNER_MODEL: "gpt-test",
      LORE_QUERY_PLANNER_BASE_URL: "",
      LORE_QUERY_PLANNER_API_KEY: "   ",
      OPENAI_API_KEY: "secret",
    }),
  ).toMatchObject({ provider: "openai", model: "gpt-test" });
});

test("query planning accepts native Ollama and inherits its deployment endpoint", () => {
  expect(
    createQueryPlanningProviderFromEnvironment({
      LORE_QUERY_PLANNER_PROVIDER: "ollama",
      LORE_QUERY_PLANNER_MODEL: "qwen3.5:4b",
      OLLAMA_BASE_URL: "http://ollama.internal:11434",
      OLLAMA_KEEP_ALIVE: "5m",
    }),
  ).toMatchObject({ provider: "ollama", model: "qwen3.5:4b" });
});

test("query planning reports runtime failures without blocking search fallback", async () => {
  const warnings: string[] = [];
  vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
  try {
    const provider = createQueryPlanningProviderFromEnvironment(
      {
        LORE_QUERY_PLANNER_PROVIDER: "vllm",
        LORE_QUERY_PLANNER_MODEL: "Qwen/Qwen3-4B-Instruct",
        LORE_QUERY_PLANNER_BASE_URL: "http://planner.test/v1",
      },
      (message) => warnings.push(message),
    );

    await expect(provider?.plan({ query: "query", maxQueries: 2 })).rejects.toThrow("HTTP 503");
    expect(warnings).toEqual([
      "Lore vllm/Qwen/Qwen3-4B-Instruct query planning failed; using the original query",
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
