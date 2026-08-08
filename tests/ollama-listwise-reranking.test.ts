import { expect, test } from "vitest";
import {
  createOllamaListwiseRerankingProvider,
  OLLAMA_LISTWISE_INSTRUCTION_SHA256,
} from "@/lib/reranking/ollama-listwise";

test("Ollama listwise adapter scores every opaque candidate with deterministic controls", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOllamaListwiseRerankingProvider({
    model: "qwen3.5:4b",
    baseUrl: "http://127.0.0.1:11435",
    keepAlive: "5m",
    maximumDocumentCharacters: 12,
    fetch: async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:11435/api/chat");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        message: {
          content: JSON.stringify({
            scores: [
              { id: "c0", score: 0.2 },
              { id: "c1", score: 0.95 },
              { id: "c2", score: 0.5 },
            ],
          }),
        },
      });
    },
  });

  const results = await provider.rerank({
    query: "Where did I study?",
    documents: [
      { id: "private-memory-id", text: "I like tea and coffee." },
      { id: "answer-memory-id", text: "I graduated from MIT." },
      { id: "context-memory-id", text: "I studied in Boston." },
    ],
    limit: 2,
  });

  expect(provider).toMatchObject({
    provider: "ollama-listwise",
    revision: "lore-ollama-listwise-reranking-v1",
    transport: "ollama-chat-v1",
    keepAlive: "5m",
    decoding: { instructionSha256: OLLAMA_LISTWISE_INSTRUCTION_SHA256 },
  });
  expect(requestBody).toMatchObject({
    model: "qwen3.5:4b",
    stream: false,
    think: false,
    keep_alive: "5m",
    options: {
      temperature: 0,
      top_p: 1,
      top_k: 1,
      seed: 42,
      num_ctx: 8192,
      num_predict: 2048,
    },
  });
  const messages = requestBody?.messages as Array<{ content: string }>;
  expect(messages[1]?.content).toContain('"id":"c0"');
  expect(messages[1]?.content).toContain("I like tea ");
  expect(messages[1]?.content).not.toContain("private-memory-id");
  expect(results).toEqual([
    { documentId: "answer-memory-id", score: 0.95 },
    { documentId: "context-memory-id", score: 0.5 },
  ]);
});

test("Ollama listwise adapter rejects missing, duplicate, foreign, and unbounded scores", async () => {
  const invalidScores = [
    [{ id: "c0", score: 0.8 }],
    [
      { id: "c0", score: 0.8 },
      { id: "c0", score: 0.7 },
    ],
    [
      { id: "c0", score: 0.8 },
      { id: "foreign", score: 0.7 },
    ],
    [
      { id: "c0", score: 0.8 },
      { id: "c1", score: 1.1 },
    ],
  ];

  for (const scores of invalidScores) {
    const provider = createOllamaListwiseRerankingProvider({
      model: "qwen3.5:4b",
      fetch: async () => Response.json({ message: { content: JSON.stringify({ scores }) } }),
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
    ).rejects.toThrow(/wrong number|invalid score/);
  }
});
