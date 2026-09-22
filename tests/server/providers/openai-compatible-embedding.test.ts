import { expect, test } from "vitest";
import {
  createOpenAIEmbeddingProvider,
  createVercelAIGatewayEmbeddingProvider,
} from "@/server/providers/embedding/openai-compatible";

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
      revision: "lore-embedding-v1",
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
      revision: "lore-embedding-v1",
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
      revision: "lore-embedding-v1",
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
        revision: "lore-embedding-v1",
      },
      { apiKey: "" },
    ),
  ).toThrow("OPENAI_API_KEY is required");

  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-openai-key",
      fetch: async () => Response.json({ data: [{ index: 0, embedding: [0.5] }] }),
    },
  );
  await expect(provider.embed(["memory"], "document")).rejects.toThrow("invalid embedding");
});

test("OpenAI SDK retries rate limits using Retry-After and the configured retry budget", async () => {
  let requests = 0;
  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-openai-key",
      fetch: async () => {
        requests += 1;
        return requests < 3
          ? Response.json(
              { error: { message: "rate limited" } },
              { status: 429, headers: { "retry-after-ms": "1" } },
            )
          : Response.json({ data: [{ index: 0, embedding: vector() }] });
      },
    },
  );

  await expect(provider.embed(["memory"], "document")).resolves.toEqual([vector()]);
  expect(requests).toBe(3);
});

test("OpenAI adapter honors zero retries and omits provider error bodies", async () => {
  let requests = 0;
  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-openai-key",
      maxRetries: 0,
      fetch: async () => {
        requests += 1;
        return Response.json({ error: { message: "private provider details" } }, { status: 503 });
      },
    },
  );

  await expect(provider.embed(["memory"], "document")).rejects.toThrow(
    /^OpenAI embedding request failed \(503\)$/,
  );
  expect(requests).toBe(1);
});

test("OpenAI adapter rejects duplicate result indices before accepting any vectors", async () => {
  const provider = createOpenAIEmbeddingProvider(
    {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
      revision: "lore-embedding-v1",
    },
    {
      apiKey: "test-openai-key",
      fetch: async () =>
        Response.json({
          data: [
            { index: 0, embedding: vector() },
            { index: 0, embedding: vector() },
          ],
        }),
    },
  );

  await expect(provider.embed(["first", "second"], "document")).rejects.toThrow(
    "OpenAI returned an invalid embedding",
  );
});

const gatewayConfiguration = {
  provider: "vercel",
  model: "openai/text-embedding-3-small",
  dimensions: 1024,
  revision: "lore-embedding-v1",
} as const;

test("Vercel AI Gateway adapter posts the deployment dimensions to the gateway", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createVercelAIGatewayEmbeddingProvider(gatewayConfiguration, {
    apiKey: "test-gateway-key",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://ai-gateway.vercel.sh/v1/embeddings");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-gateway-key");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: [{ index: 0, embedding: vector() }] });
    },
  });

  await expect(provider.embed(["memory"], "document")).resolves.toEqual([vector()]);
  expect(requestBody).toEqual({
    input: ["memory"],
    model: "openai/text-embedding-3-small",
    dimensions: 1024,
    encoding_format: "float",
  });
});

test("Vercel AI Gateway adapter fails closed on model ids, credentials, and vector width", async () => {
  expect(() =>
    createVercelAIGatewayEmbeddingProvider(
      { ...gatewayConfiguration, model: "text-embedding-3-small" },
      { apiKey: "test-gateway-key" },
    ),
  ).toThrow("creator/model ids");
  expect(() =>
    createVercelAIGatewayEmbeddingProvider(gatewayConfiguration, { apiKey: " " }),
  ).toThrow("AI_GATEWAY_API_KEY is required");
  expect(() =>
    createVercelAIGatewayEmbeddingProvider(
      { ...gatewayConfiguration, provider: "openai" },
      { apiKey: "test-gateway-key" },
    ),
  ).toThrow("Vercel AI Gateway adapter requires provider=vercel");

  const provider = createVercelAIGatewayEmbeddingProvider(gatewayConfiguration, {
    apiKey: "test-gateway-key",
    fetch: async () => Response.json({ data: [{ index: 0, embedding: vector(768) }] }),
  });
  await expect(provider.embed(["memory"], "document")).rejects.toThrow(
    "Vercel AI Gateway returned an invalid embedding",
  );
});

test("Vercel AI Gateway adapter names itself in request failures without upstream bodies", async () => {
  const provider = createVercelAIGatewayEmbeddingProvider(gatewayConfiguration, {
    apiKey: "test-gateway-key",
    maxRetries: 0,
    fetch: async () =>
      Response.json({ error: { message: "upstream provider details" } }, { status: 502 }),
  });

  await expect(provider.embed(["memory"], "document")).rejects.toThrow(
    /^Vercel AI Gateway embedding request failed \(502\)$/,
  );
});
