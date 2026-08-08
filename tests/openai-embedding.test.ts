import { expect, test } from "vitest";
import { createOpenAIEmbeddingProvider } from "@/lib/embedding/openai";

const vector = (dimensions = 1024, first = 0.5) => [
  first,
  ...Array.from({ length: dimensions - 1 }, () => 0.5),
];

test("OpenAI adapter sends a float batch with the deployment dimensions", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
    {
      apiKey: "test-openai-key",
      baseUrl: "https://openai.test/",
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://openai.test/v1/embeddings");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-openai-key");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          data: [
            { index: 0, embedding: vector() },
            { index: 1, embedding: vector() },
          ],
        });
      },
    },
  );

  const embeddings = await provider.embed(["first memory", "second memory"], "document");

  expect(embeddings).toHaveLength(2);
  expect(requestBody).toEqual({
    input: ["first memory", "second memory"],
    model: "text-embedding-3-small",
    dimensions: 1024,
    encoding_format: "float",
  });
});

test("OpenAI adapter restores API results to input order", async () => {
  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-large",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
    {
      apiKey: "test-openai-key",
      fetch: async () =>
        Response.json({
          data: [
            { index: 1, embedding: vector(1024, 2) },
            { index: 0, embedding: vector(1024, 1) },
          ],
        }),
    },
  );

  const embeddings = await provider.embed(["first", "second"], "query");

  expect(embeddings.map((embedding) => embedding[0])).toEqual([1, 2]);
});

test("OpenAI adapter splits requests into conservative batches", async () => {
  const batches: string[][] = [];
  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
    {
      apiKey: "test-openai-key",
      batchSize: 2,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        batches.push(body.input);
        return Response.json({
          data: body.input.map((_text, index) => ({ index, embedding: vector() })),
        });
      },
    },
  );

  await provider.embed(["1", "2", "3"], "document");

  expect(batches).toEqual([["1", "2"], ["3"]]);
});

test("OpenAI adapter fails closed when its credential or response is invalid", async () => {
  expect(() =>
    createOpenAIEmbeddingProvider(
      {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1024,
        revision: "lore-embedding-v2",
      },
      { apiKey: "" },
    ),
  ).toThrow("OPENAI_API_KEY is required");

  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
      revision: "lore-embedding-v2",
    },
    {
      apiKey: "test-openai-key",
      fetch: async () => Response.json({ data: [{ index: 0, embedding: [0.5] }] }),
    },
  );
  await expect(provider.embed(["memory"], "document")).rejects.toThrow("invalid embedding");
});
