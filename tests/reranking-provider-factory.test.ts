import { expect, test, vi } from "vitest";
import { createRerankingProviderFromEnvironment } from "@/lib/reranking/provider-factory";

test("reranking provider factory stays disabled unless explicitly configured", () => {
  expect(createRerankingProviderFromEnvironment({})).toBeUndefined();
});

test.each([
  ["an unsupported provider", { LORE_RERANK_PROVIDER: "ollama" }],
  ["a missing model", { LORE_RERANK_PROVIDER: "vllm" }],
  [
    "a missing managed API key",
    { LORE_RERANK_PROVIDER: "cohere", LORE_RERANK_MODEL: "rerank-v4.0-pro" },
  ],
  [
    "an invalid URL",
    {
      LORE_RERANK_PROVIDER: "vllm",
      LORE_RERANK_MODEL: "Qwen/Qwen3-Reranker-0.6B",
      LORE_RERANK_BASE_URL: "localhost:8000",
    },
  ],
  [
    "an insecure managed URL",
    {
      LORE_RERANK_PROVIDER: "cohere",
      LORE_RERANK_MODEL: "rerank-v4.0-pro",
      LORE_RERANK_API_KEY: "secret",
      LORE_RERANK_BASE_URL: "http://cohere.internal",
    },
  ],
])("reranking provider factory degrades safely for %s", (_case, env) => {
  const warnings: string[] = [];

  expect(createRerankingProviderFromEnvironment(env, (message) => warnings.push(message))).toBe(
    undefined,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/^Lore reranking disabled: /);
});

test("reranking provider factory supports explicit managed adapters", () => {
  expect(
    createRerankingProviderFromEnvironment({
      LORE_RERANK_PROVIDER: "cohere",
      LORE_RERANK_MODEL: "rerank-v4.0-pro",
      LORE_RERANK_BASE_URL: "",
      COHERE_API_KEY: "secret",
    }),
  ).toMatchObject({ provider: "cohere", model: "rerank-v4.0-pro" });
  expect(
    createRerankingProviderFromEnvironment({
      LORE_RERANK_PROVIDER: "memos",
      LORE_RERANK_MODEL: "memos-reranker-0.6b",
      MEMOS_API_KEY: "secret",
    }),
  ).toMatchObject({ provider: "memos", model: "memos-reranker-0.6b" });
  expect(
    createRerankingProviderFromEnvironment({
      LORE_RERANK_PROVIDER: "voyage",
      LORE_RERANK_MODEL: "rerank-2.5",
      VOYAGE_API_KEY: "secret",
    }),
  ).toMatchObject({ provider: "voyage", model: "rerank-2.5" });
});

test("reranking provider factory supports llama.cpp without pretending it accepts instructions", () => {
  const warnings: string[] = [];
  const provider = createRerankingProviderFromEnvironment(
    {
      LORE_RERANK_PROVIDER: "llamacpp",
      LORE_RERANK_MODEL: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0",
      LORE_RERANK_INSTRUCTION: "ignored",
    },
    (message) => warnings.push(message),
  );

  expect(provider).toMatchObject({
    provider: "llamacpp",
    revision: "lore-llamacpp-reranking-v1",
    instruction: "Given a web search query, retrieve relevant passages that answer the query",
  });
  expect(warnings).toEqual([
    "Lore llamacpp reranking ignores LORE_RERANK_INSTRUCTION; the GGUF model owns its template",
  ]);
});

test("reranking provider factory supports the vLLM score adapter", () => {
  expect(
    createRerankingProviderFromEnvironment({
      LORE_RERANK_PROVIDER: "vllm-score",
      LORE_RERANK_MODEL: "mku64/Qwen3-Reranker-0.6B-mlx-8Bit",
    }),
  ).toMatchObject({
    provider: "vllm-score",
    revision: "lore-vllm-score-reranking-v1",
  });
});

test("reranking provider factory supports deterministic Ollama listwise scoring", () => {
  expect(
    createRerankingProviderFromEnvironment({
      LORE_RERANK_PROVIDER: "ollama-listwise",
      LORE_RERANK_MODEL: "qwen3.5:4b",
      LORE_RERANK_BASE_URL: "http://127.0.0.1:11435",
      LORE_RERANK_NUM_CTX: "8192",
      LORE_RERANK_MAX_OUTPUT_TOKENS: "2048",
      LORE_RERANK_MAX_DOCUMENT_CHARS: "600",
      LORE_RERANK_KEEP_ALIVE: "5m",
    }),
  ).toMatchObject({
    provider: "ollama-listwise",
    model: "qwen3.5:4b",
    revision: "lore-ollama-listwise-reranking-v1",
    transport: "ollama-chat-v1",
    keepAlive: "5m",
  });
});

test("reranking provider factory reports runtime failures without blocking fallback", async () => {
  const warnings: string[] = [];
  vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
  try {
    const provider = createRerankingProviderFromEnvironment(
      {
        LORE_RERANK_PROVIDER: "vllm",
        LORE_RERANK_MODEL: "Qwen/Qwen3-Reranker-0.6B",
        LORE_RERANK_BASE_URL: "http://reranker.test",
      },
      (message) => warnings.push(message),
    );

    await expect(
      provider?.rerank({
        query: "query",
        documents: [{ id: "memory", text: "memory" }],
        limit: 1,
      }),
    ).rejects.toThrow("HTTP 503");
    expect(warnings).toEqual([
      "Lore vllm/Qwen/Qwen3-Reranker-0.6B reranking failed; using deterministic retrieval order",
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
