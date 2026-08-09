import { expect, test } from "vitest";
import {
  createLlamaCppRerankingProvider,
  createVllmRerankingProvider,
  createVllmScoreRerankingProvider,
} from "@/lib/reranking/vllm";

test("vLLM adapter sends the official rerank request and restores document ids", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createVllmRerankingProvider({
    model: "Qwen/Qwen3-Reranker-0.6B",
    baseUrl: "https://reranker.test/",
    apiKey: "test-key",
    instruction: "Retrieve relevant personal memories",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://reranker.test/v1/rerank");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.4 },
        ],
      });
    },
  });

  const results = await provider.rerank({
    query: "Where did I study?",
    documents: [
      { id: "first", text: "I studied in Boston." },
      { id: "second", text: "I graduated from MIT." },
      { id: "third", text: "I like tea." },
    ],
    limit: 2,
  });

  expect(requestBody).toEqual({
    model: "Qwen/Qwen3-Reranker-0.6B",
    query: "Where did I study?",
    documents: ["I studied in Boston.", "I graduated from MIT.", "I like tea."],
    top_n: 2,
    chat_template_kwargs: { instruction: "Retrieve relevant personal memories" },
  });
  expect(results).toEqual([
    { documentId: "second", score: 0.9 },
    { documentId: "first", score: 0.4 },
  ]);
});

test("vLLM adapters require HTTPS outside localhost", () => {
  expect(() =>
    createVllmRerankingProvider({
      model: "Qwen/Qwen3-Reranker-0.6B",
      baseUrl: "http://reranker.example.com",
    }),
  ).toThrow("must use https outside localhost");
  expect(() =>
    createVllmScoreRerankingProvider({
      model: "Qwen/Qwen3-Reranker-0.6B",
      baseUrl: "http://reranker.example.com",
    }),
  ).toThrow("must use https outside localhost");
});

test("vLLM adapter rejects malformed or duplicate result indexes", async () => {
  const provider = createVllmRerankingProvider({
    model: "Qwen/Qwen3-Reranker-0.6B",
    fetch: async () =>
      Response.json({
        results: [
          { index: 0, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.7 },
        ],
      }),
  });

  await expect(
    provider.rerank({
      query: "query",
      documents: [
        { id: "first", text: "first" },
        { id: "second", text: "second" },
      ],
      limit: 2,
    }),
  ).rejects.toThrow("invalid reranking result");
});

test("vLLM adapter rejects unnormalized logits", async () => {
  const provider = createVllmRerankingProvider({
    model: "Qwen/Qwen3-Reranker-0.6B",
    fetch: async () => Response.json({ results: [{ index: 0, relevance_score: 1.1 }] }),
  });

  await expect(
    provider.rerank({
      query: "query",
      documents: [{ id: "first", text: "first" }],
      limit: 1,
    }),
  ).rejects.toThrow("invalid reranking result");
});

test("llama.cpp adapter uses its native request and reports the model-owned Qwen instruction", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createLlamaCppRerankingProvider({
    model: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0",
    fetch: async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:8080/v1/rerank");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ results: [{ index: 0, relevance_score: 0.99 }] });
    },
  });

  const results = await provider.rerank({
    query: "Where did I study?",
    documents: [{ id: "memory", text: "I graduated from MIT." }],
    limit: 1,
  });

  expect(provider).toMatchObject({
    provider: "llamacpp",
    revision: "lore-llamacpp-reranking-v1",
    instruction: "Given a web search query, retrieve relevant passages that answer the query",
  });
  expect(requestBody).toEqual({
    model: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0",
    query: "Where did I study?",
    documents: ["I graduated from MIT."],
    top_n: 1,
  });
  expect(results).toEqual([{ documentId: "memory", score: 0.99 }]);
});

test("vLLM score adapter uses the Metal-tested pairwise request and sorts scores", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createVllmScoreRerankingProvider({
    model: "mku64/Qwen3-Reranker-0.6B-mlx-8Bit",
    baseUrl: "http://127.0.0.1:8000",
    instruction: "Retrieve relevant personal memories",
    fetch: async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:8000/score");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        data: [
          { index: 0, object: "score", score: 0.2 },
          { index: 1, object: "score", score: 0.95 },
          { index: 2, object: "score", score: 0.5 },
        ],
      });
    },
  });

  const results = await provider.rerank({
    query: "Where did I study?",
    documents: [
      { id: "first", text: "I like tea." },
      { id: "second", text: "I graduated from MIT." },
      { id: "third", text: "I studied in Boston." },
    ],
    limit: 2,
  });

  expect(provider).toMatchObject({
    provider: "vllm-score",
    revision: "lore-vllm-score-reranking-v1",
  });
  expect(requestBody).toEqual({
    model: "mku64/Qwen3-Reranker-0.6B-mlx-8Bit",
    text_1: ["Where did I study?", "Where did I study?", "Where did I study?"],
    text_2: ["I like tea.", "I graduated from MIT.", "I studied in Boston."],
    instruction: "Retrieve relevant personal memories",
  });
  expect(results).toEqual([
    { documentId: "second", score: 0.95 },
    { documentId: "third", score: 0.5 },
  ]);
});

test("vLLM score adapter rejects incomplete or unnormalized scores", async () => {
  const provider = createVllmScoreRerankingProvider({
    model: "mku64/Qwen3-Reranker-0.6B-mlx-8Bit",
    fetch: async () => Response.json({ data: [{ index: 0, score: 1.1 }] }),
  });

  await expect(
    provider.rerank({
      query: "query",
      documents: [{ id: "first", text: "first" }],
      limit: 1,
    }),
  ).rejects.toThrow("invalid reranking result");
});
