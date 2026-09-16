import { afterEach, expect, test, vi } from "vitest";
import { createOpenAICompatibleQueryPlanningProvider } from "@/server/providers/query-planning/openai-compatible";

afterEach(() => vi.unstubAllEnvs());

test("OpenAI-compatible query planning requests JSON and returns bounded queries", async () => {
  const provider = createOpenAICompatibleQueryPlanningProvider({
    provider: "vllm",
    model: "Qwen/Qwen3-4B-Instruct",
    baseUrl: "http://planner.test/v1/",
    fetch: async (input, init) => {
      expect(String(input)).toBe("http://planner.test/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("authorization")).toBe(false);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "Qwen/Qwen3-4B-Instruct",
        temperature: 0,
        max_tokens: 256,
        response_format: { type: "json_object" },
      });
      expect(body.messages.at(-1).content).toContain("Maximum retrieval queries: 2");
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                queries: [" first evidence ", "second evidence", "ignored evidence"],
              }),
            },
          },
        ],
      });
    },
  });

  await expect(provider.plan({ query: "Compare both events", maxQueries: 2 })).resolves.toEqual([
    "first evidence",
    "second evidence",
  ]);
});

test("vLLM query planning does not inherit OpenAI environment credentials", async () => {
  vi.stubEnv("OPENAI_API_KEY", "unrelated-openai-key");
  vi.stubEnv("OPENAI_ADMIN_KEY", "unrelated-admin-key");
  vi.stubEnv("OPENAI_ORG_ID", "unrelated-organization");
  vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-project");
  const provider = createOpenAICompatibleQueryPlanningProvider({
    provider: "vllm",
    model: "fixture",
    apiKey: " ",
    baseUrl: "http://planner.test/proxy/v1/",
    fetch: async (input, init) => {
      expect(String(input)).toBe("http://planner.test/proxy/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("api-key")).toBe(false);
      expect(headers.has("openai-organization")).toBe(false);
      expect(headers.has("openai-project")).toBe(false);
      return Response.json({ choices: [{ message: { content: '{"queries":["query"]}' } }] });
    },
  });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).resolves.toEqual(["query"]);
});

test("OpenAI query planning leaves retries disabled and hides provider error bodies", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { message: "sensitive provider details" } }, { status: 429 }),
    );
  const provider = createOpenAICompatibleQueryPlanningProvider({
    provider: "openai",
    model: "fixture",
    apiKey: "test-key",
    fetch,
  });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).rejects.toThrow(
    /^query planner request failed with HTTP 429$/,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("OpenAI-compatible query planning rejects malformed model output", async () => {
  const provider = createOpenAICompatibleQueryPlanningProvider({
    provider: "vllm",
    model: "fixture",
    fetch: async () => Response.json({ choices: [{ message: { content: '{"queries":[42]}' } }] }),
  });

  await expect(provider.plan({ query: "query", maxQueries: 2 })).rejects.toThrow(
    "invalid queries array",
  );
});

test("custom OpenAI planner instructions retain the required JSON contract", async () => {
  const provider = createOpenAICompatibleQueryPlanningProvider({
    provider: "openai",
    model: "fixture",
    apiKey: "test",
    instruction: "Preserve domain-specific identifiers.",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContain("Preserve domain-specific identifiers.");
      expect(body.messages[0].content).toContain("JSON object");
      return Response.json({ choices: [{ message: { content: '{"queries":["query"]}' } }] });
    },
  });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).resolves.toEqual(["query"]);
});
