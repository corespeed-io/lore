import { afterEach, expect, test, vi } from "vitest";
import { createOllamaQueryPlanningProvider } from "@/server/providers/query-planning/ollama";

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return Object.assign(vi.fn(implementation), { preconnect: globalThis.fetch.preconnect });
}

afterEach(() => vi.unstubAllEnvs());

test("Ollama planners omit invalid JSON content from SDK parsing errors", async () => {
  const provider = createOllamaQueryPlanningProvider({
    model: "qwen3.5:4b",
    fetch: mockFetch(async () => new Response("private provider text, invalid JSON")),
  });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).rejects.toThrow(
    /^Ollama query planner request failed$/,
  );
});

test("Ollama planners reject cloud hosts before the SDK can inherit cloud credentials", async () => {
  vi.stubEnv("OLLAMA_API_KEY", "unrelated-cloud-key");
  const fetch = mockFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    return Response.json({ done: true, message: { content: '{"queries":["retrieval query"]}' } });
  });

  expect(() =>
    createOllamaQueryPlanningProvider({
      model: "qwen3.5:4b",
      baseUrl: "https://ollama.com",
      fetch,
    }),
  ).toThrow("ollama.com is not supported");
  expect(fetch).not.toHaveBeenCalled();

  const provider = createOllamaQueryPlanningProvider({
    model: "qwen3.5:4b",
    baseUrl: "https://private-ollama.example.com",
    fetch,
  });
  await expect(provider.plan({ query: "question", maxQueries: 1 })).resolves.toEqual([
    "retrieval query",
  ]);
});

test("Ollama query planning uses native bounded deterministic structured output", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOllamaQueryPlanningProvider({
    model: "qwen3.5:4b",
    baseUrl: "http://ollama.local:11434/",
    keepAlive: "5m",
    contextWindowTokens: 8192,
    fetch: mockFetch(async (input, init) => {
      expect(String(input)).toBe("http://ollama.local:11434/api/chat");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        done: true,
        message: { content: '{"queries":[" Alice city ","Alice move reason","ignored"]}' },
      });
    }),
  });

  await expect(
    provider.plan({ query: "Where and why did Alice move?", maxQueries: 2 }),
  ).resolves.toEqual(["Alice city", "Alice move reason"]);
  expect(requestBody).toMatchObject({
    model: "qwen3.5:4b",
    stream: false,
    think: false,
    keep_alive: "5m",
    options: {
      temperature: 0,
      seed: 42,
      top_p: 1,
      top_k: 1,
      num_ctx: 8192,
      num_predict: 256,
    },
  });
  expect(requestBody?.format).toMatchObject({
    type: "object",
    properties: { queries: { type: "array", maxItems: 2 } },
    required: ["queries"],
    additionalProperties: false,
  });
});

test("Ollama query planning preserves path prefixes and defaults", async () => {
  const provider = createOllamaQueryPlanningProvider({
    model: "fixture",
    baseUrl: "http://ollama.local:11434/proxy/",
    fetch: mockFetch(async (input, init) => {
      expect(String(input)).toBe("http://ollama.local:11434/proxy/api/chat");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        keep_alive: 0,
        think: false,
        stream: false,
        options: { num_ctx: 4096, num_predict: 256 },
      });
      return Response.json({ done: true, message: { content: '{"queries":["query"]}' } });
    }),
  });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).resolves.toEqual(["query"]);
});

test("Ollama query planning does not retry or expose HTTP error bodies", async () => {
  const fetch = mockFetch(async () =>
    Response.json({ error: "sensitive provider details" }, { status: 503 }),
  );
  const provider = createOllamaQueryPlanningProvider({ model: "fixture", fetch });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).rejects.toThrow(
    /^Ollama query planner request failed with HTTP 503$/,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ["an incomplete response", { done: false, message: { content: '{"queries":[]}' } }],
  [
    "a remote response",
    { done: true, remote_model: "cloud-model", message: { content: '{"queries":[]}' } },
  ],
  ["missing content", { done: true, message: {} }],
])("Ollama query planning rejects %s", async (_case, payload) => {
  const provider = createOllamaQueryPlanningProvider({
    model: "qwen3.5:4b",
    fetch: mockFetch(async () => Response.json(payload)),
  });

  await expect(provider.plan({ query: "query", maxQueries: 2 })).rejects.toThrow();
});
