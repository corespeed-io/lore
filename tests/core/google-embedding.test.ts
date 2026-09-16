import { createGoogleEmbeddingProvider } from "@corespeed/lore-core/providers";
import { afterEach, expect, test, vi } from "vitest";

const vector = (dimensions = 1024) => Array.from({ length: dimensions }, () => 0.5);
const configuration = {
  provider: "google",
  model: "gemini-embedding-2",
  dimensions: 1024,
  revision: "lore-embedding-v1",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("Google SDK sends document embeddings through the batch API", async () => {
  let requestBody: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(
      "https://google.test/v1beta/models/gemini-embedding-2:batchEmbedContents",
    );
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-google-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ embeddings: [{ values: vector() }, { values: vector() }] });
  });
  const provider = createGoogleEmbeddingProvider(configuration, {
    apiKey: "test-google-key",
    baseUrl: "https://google.test/",
  });

  const embeddings = await provider.embed(["first memory", "second memory"], "document");

  expect(embeddings).toHaveLength(2);
  expect(requestBody).toEqual({
    requests: ["first memory", "second memory"].map((text) => ({
      model: "models/gemini-embedding-2",
      content: { parts: [{ text: `title: none | text: ${text}` }] },
      outputDimensionality: 1024,
    })),
  });
});

test("Google adapter distinguishes query embeddings", async () => {
  let requestBody: {
    requests?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      taskType?: string;
    }>;
  } = {};
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
    return Response.json({ embeddings: [{ values: vector() }] });
  });
  const provider = createGoogleEmbeddingProvider(
    { ...configuration, model: "models/gemini-embedding-2" },
    { apiKey: "test-google-key" },
  );

  await provider.embed(["where is the launch plan?"], "query");

  expect(provider.model).toBe("gemini-embedding-2");
  expect(requestBody.requests?.[0]?.content?.parts?.[0]?.text).toBe(
    "task: search result | query: where is the launch plan?",
  );
  expect(requestBody.requests?.[0]?.taskType).toBeUndefined();
});

test.each([
  ["query", "RETRIEVAL_QUERY"],
  ["document", "RETRIEVAL_DOCUMENT"],
] as const)("Google SDK keeps the legacy model's %s task type", async (task, expectedTaskType) => {
  let requestBody: {
    requests?: Array<{ taskType?: string; outputDimensionality?: number }>;
  } = {};
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
    return Response.json({ embeddings: [{ values: vector() }] });
  });
  const provider = createGoogleEmbeddingProvider(
    { ...configuration, model: "gemini-embedding-001" },
    { apiKey: "test-google-key" },
  );

  await provider.embed(["where is the launch plan?"], task);

  expect(requestBody.requests?.[0]?.taskType).toBe(expectedTaskType);
  expect(requestBody.requests?.[0]?.outputDimensionality).toBe(1024);
});

test("Google adapter splits requests into bounded batches without reordering", async () => {
  const batches: string[][] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
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
  });
  const provider = createGoogleEmbeddingProvider(configuration, {
    apiKey: "test-google-key",
    batchSize: 2,
  });

  const embeddings = await provider.embed(["1", "2", "3"], "document");

  expect(batches).toEqual([["1", "2"], ["3"]]);
  expect(embeddings.map((embedding) => embedding[0])).toEqual([1, 2, 3]);
});

test("Google adapter fails closed when its credential or response is invalid", async () => {
  expect(() => createGoogleEmbeddingProvider(configuration, { apiKey: "" })).toThrow(
    "GEMINI_API_KEY is required",
  );

  vi.stubGlobal("fetch", async () => Response.json({ embeddings: [{ values: [0.5] }] }));
  const provider = createGoogleEmbeddingProvider(configuration, { apiKey: "test-google-key" });

  await expect(provider.embed(["memory"], "document")).rejects.toThrow("invalid embedding");
});

test("Google SDK retries transient failures within its configured budget", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: { code: 429, message: "busy" } }, { status: 429 }),
    )
    .mockResolvedValueOnce(Response.json({ embeddings: [{ values: vector() }] }));
  vi.stubGlobal("fetch", fetch);
  const provider = createGoogleEmbeddingProvider(configuration, {
    apiKey: "test-google-key",
    maxRetries: 1,
  });

  const embeddings = provider.embed(["memory"], "document");
  await vi.runAllTimersAsync();

  await expect(embeddings).resolves.toEqual([vector()]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("Google SDK honors zero retries and the adapter omits error bodies", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ error: { code: 503, message: "private provider details" } }, { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = createGoogleEmbeddingProvider(configuration, {
    apiKey: "test-google-key",
    maxRetries: 0,
  });

  await expect(provider.embed(["memory"], "document")).rejects.toThrow(
    /^Google embedding request failed \(503\)$/,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
