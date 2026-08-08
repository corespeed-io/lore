import { afterEach, expect, test, vi } from "vitest";
import {
  createEmbeddingProviderFromEnvironment,
  createMaintenanceEmbeddingProvidersFromEnvironment,
} from "@/lib/embedding/provider-factory";
import { markDependencySuccess, runtimeDependencyStatus } from "@/lib/telemetry";

afterEach(() => {
  markDependencySuccess("embedding");
});

test("embedding provider factory builds the default local provider", () => {
  const warnings: string[] = [];
  const provider = createEmbeddingProviderFromEnvironment({}, (message) => warnings.push(message));

  expect(provider).toMatchObject({
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    revision: "lore-embedding-v3",
  });
  expect(warnings).toEqual([]);
});

test.each([
  ["a missing Google credential", { LORE_EMBEDDING_PROVIDER: "google" }],
  ["a missing OpenAI credential", { LORE_EMBEDDING_PROVIDER: "openai" }],
  ["an unsupported provider", { LORE_EMBEDDING_PROVIDER: "gogle" }],
  [
    "an unsupported Google model",
    {
      LORE_EMBEDDING_PROVIDER: "google",
      LORE_EMBEDDING_MODEL: "text-embedding-004",
      GEMINI_API_KEY: "test-key",
    },
  ],
  ["a stale dimension override", { LORE_EMBEDDING_DIMENSIONS: "1536" }],
  ["an invalid Ollama URL", { OLLAMA_BASE_URL: "localhost:11434" }],
])("embedding provider factory degrades safely for %s", (_case, env) => {
  const warnings: string[] = [];

  expect(createEmbeddingProviderFromEnvironment(env, (message) => warnings.push(message))).toBe(
    undefined,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/^Lore embeddings disabled: /);
  expect(runtimeDependencyStatus("embedding").status).toBe("degraded");
});

test("embedding provider factory reports runtime failures without swallowing them", async () => {
  const warnings: string[] = [];
  vi.stubGlobal("fetch", async () => new Response("invalid request", { status: 400 }));
  try {
    const provider = createEmbeddingProviderFromEnvironment(
      { OLLAMA_BASE_URL: "http://ollama.test", LORE_EMBEDDING_TIMEOUT_MS: "1000" },
      (message) => warnings.push(message),
    );

    await expect(provider?.embed(["memory"], "document")).rejects.toThrow(
      "Ollama embedding request failed (400)",
    );
    expect(warnings).toEqual([
      "Lore ollama/qwen3-embedding:0.6b document embedding failed; continuing without a vector",
    ]);
    expect(runtimeDependencyStatus("embedding").status).toBe("degraded");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("maintenance provider factory keeps serving and building generations explicit", () => {
  const warnings: string[] = [];
  const providers = createMaintenanceEmbeddingProvidersFromEnvironment(
    {
      LORE_EMBEDDING_PROVIDER: "ollama",
      LORE_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
      LORE_EMBEDDING_BUILD_PROVIDER: "google",
      LORE_EMBEDDING_BUILD_MODEL: "gemini-embedding-2",
      GEMINI_API_KEY: "test-key",
    },
    (message) => warnings.push(message),
  );

  expect(providers.map(({ provider, model }) => ({ provider, model }))).toEqual([
    { provider: "ollama", model: "qwen3-embedding:0.6b" },
    { provider: "google", model: "gemini-embedding-2" },
  ]);
  expect(warnings).toEqual([]);
});

test("maintenance provider factory disables an incomplete build lane without losing serving", () => {
  const warnings: string[] = [];
  const providers = createMaintenanceEmbeddingProvidersFromEnvironment(
    { LORE_EMBEDDING_BUILD_PROVIDER: "google" },
    (message) => warnings.push(message),
  );

  expect(providers).toHaveLength(1);
  expect(providers[0]).toMatchObject({
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
  });
  expect(warnings).toEqual([
    "Lore embedding build disabled: LORE_EMBEDDING_BUILD_PROVIDER and LORE_EMBEDDING_BUILD_MODEL must be set together",
  ]);
});

test("maintenance provider factory deduplicates a build lane matching serving", () => {
  const providers = createMaintenanceEmbeddingProvidersFromEnvironment({
    LORE_EMBEDDING_PROVIDER: "ollama",
    LORE_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
    LORE_EMBEDDING_BUILD_PROVIDER: "ollama",
    LORE_EMBEDDING_BUILD_MODEL: "qwen3-embedding:0.6b",
  });

  expect(providers).toHaveLength(1);
});
