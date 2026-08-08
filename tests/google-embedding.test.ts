import { expect, test } from "vitest";
import { createGoogleEmbeddingProvider } from "@/lib/embedding/google";

const vector = (dimensions = 1024) => Array.from({ length: dimensions }, () => 0.5);

test("Google adapter sends document embeddings through the batch API", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createGoogleEmbeddingProvider(
    {
      provider: "google",
      model: "gemini-embedding-2",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-google-key",
      baseUrl: "https://google.test/",
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://google.test/v1beta/models/gemini-embedding-2:batchEmbedContents",
        );
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-google-key");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ embeddings: [{ values: vector() }, { values: vector() }] });
      },
    },
  );

  const embeddings = await provider.embed(["first memory", "second memory"], "document");

  expect(embeddings).toHaveLength(2);
  expect(requestBody).toEqual({
    requests: ["first memory", "second memory"].map((text) => ({
      model: "models/gemini-embedding-2",
      content: { parts: [{ text: `title: none | text: ${text}` }] },
      embedContentConfig: { outputDimensionality: 1024 },
    })),
  });
});

test("Google adapter distinguishes query embeddings", async () => {
  let requestBody: {
    requests?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      embedContentConfig?: { taskType?: string };
    }>;
  } = {};
  const provider = createGoogleEmbeddingProvider(
    {
      provider: "google",
      model: "models/gemini-embedding-2",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-google-key",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
        return Response.json({ embeddings: [{ values: vector() }] });
      },
    },
  );

  await provider.embed(["where is the launch plan?"], "query");

  expect(provider.model).toBe("gemini-embedding-2");
  expect(requestBody.requests?.[0]?.content?.parts?.[0]?.text).toBe(
    "task: search result | query: where is the launch plan?",
  );
  expect(requestBody.requests?.[0]?.embedContentConfig?.taskType).toBeUndefined();
});

test("Google adapter keeps task types for the legacy text-only model", async () => {
  let requestBody: {
    requests?: Array<{ embedContentConfig?: { taskType?: string } }>;
  } = {};
  const provider = createGoogleEmbeddingProvider(
    {
      provider: "google",
      model: "gemini-embedding-001",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-google-key",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
        return Response.json({ embeddings: [{ values: vector() }] });
      },
    },
  );

  await provider.embed(["where is the launch plan?"], "query");

  expect(requestBody.requests?.[0]?.embedContentConfig?.taskType).toBe("RETRIEVAL_QUERY");
});

test("Google adapter splits requests into bounded batches without reordering", async () => {
  const batches: string[][] = [];
  const provider = createGoogleEmbeddingProvider(
    {
      provider: "google",
      model: "gemini-embedding-2",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-google-key",
      batchSize: 2,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          requests: Array<{ content: { parts: Array<{ text: string }> } }>;
        };
        const texts = body.requests.map((request) =>
          request.content.parts[0].text.replace("title: none | text: ", ""),
        );
        batches.push(texts);
        return Response.json({
          embeddings: texts.map((text) => ({
            values: [Number(text), ...Array.from({ length: 1023 }, () => 0)],
          })),
        });
      },
    },
  );

  const embeddings = await provider.embed(["1", "2", "3"], "document");

  expect(batches).toEqual([["1", "2"], ["3"]]);
  expect(embeddings.map((embedding) => embedding[0])).toEqual([1, 2, 3]);
});

test("Google adapter fails closed when its credential or response is invalid", async () => {
  expect(() =>
    createGoogleEmbeddingProvider(
      {
        provider: "google",
        model: "gemini-embedding-001",
        dimensions: 1024,
        revision: "lore-embedding-v1",
      },
      { apiKey: "" },
    ),
  ).toThrow("GEMINI_API_KEY is required");

  const provider = createGoogleEmbeddingProvider(
    {
      provider: "google",
      model: "gemini-embedding-2",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-google-key",
      fetch: async () => Response.json({ embeddings: [{ values: [0.5] }] }),
    },
  );
  await expect(provider.embed(["memory"], "document")).rejects.toThrow("invalid embedding");
});

test("Google adapter retries transient failures with bounded backoff", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const provider = createGoogleEmbeddingProvider(
    {
      provider: "google",
      model: "gemini-embedding-2",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-google-key",
      retryBaseDelayMs: 10,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("busy", { status: 429 })
          : Response.json({ embeddings: [{ values: vector() }] });
      },
    },
  );

  await provider.embed(["memory"], "document");

  expect(attempts).toBe(2);
  expect(delays).toEqual([10]);
});
