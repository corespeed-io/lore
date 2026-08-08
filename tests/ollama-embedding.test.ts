import { expect, test } from "vitest";
import { createOllamaEmbeddingProvider } from "@/lib/embedding/ollama";

test("Ollama adapter sends the deployment model, dimensions, and unload policy", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOllamaEmbeddingProvider(
    {
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
    {
      baseUrl: "http://ollama.local:11434/",
      keepAlive: 0,
      fetch: async (input, init) => {
        expect(String(input)).toBe("http://ollama.local:11434/api/embed");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ embeddings: [Array.from({ length: 1024 }, () => 0.5)] });
      },
    },
  );

  const embeddings = await provider.embed(["remember this"], "document");

  expect(embeddings).toHaveLength(1);
  expect(embeddings[0]).toHaveLength(1024);
  expect(requestBody).toEqual({
    model: "qwen3-embedding:0.6b",
    input: ["remember this"],
    dimensions: 1024,
    keep_alive: 0,
  });
});

test("Ollama adapter applies the official Qwen3 retrieval instruction only to queries", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const provider = createOllamaEmbeddingProvider(
    {
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
    {
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ embeddings: [Array.from({ length: 1024 }, () => 0.5)] });
      },
    },
  );

  await provider.embed(["A stored Memory."], "document");
  await provider.embed(["Who bought the rights?"], "query");

  expect(requests.map((request) => request.input)).toEqual([
    ["A stored Memory."],
    [
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:Who bought the rights?",
    ],
  ]);
});

test("Ollama adapter leaves non-Qwen query text unchanged", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOllamaEmbeddingProvider(
    {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ embeddings: [Array.from({ length: 1024 }, () => 0.5)] });
      },
    },
  );

  await provider.embed(["Who bought the rights?"], "query");

  expect(requestBody?.input).toEqual(["Who bought the rights?"]);
});

test.each([
  ["a malformed vector", ["not-a-vector"]],
  ["the wrong dimensions", [[0.5]]],
  ["a non-finite value", [[Number.NaN, ...Array.from({ length: 1023 }, () => 0.5)]]],
])("Ollama adapter rejects %s", async (_case, embeddings) => {
  const provider = createOllamaEmbeddingProvider(
    {
      provider: "ollama",
      model: "qwen3-embedding:4b",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
    { fetch: async () => Response.json({ embeddings }) },
  );

  await expect(provider.embed(["query"], "query")).rejects.toThrow("invalid embedding");
});
