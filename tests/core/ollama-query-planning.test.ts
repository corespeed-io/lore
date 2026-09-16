import { createOllamaQueryPlanningProvider } from "@corespeed/lore-core/providers";
import { expect, test } from "vitest";

test("Ollama query planning uses native bounded deterministic structured output", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOllamaQueryPlanningProvider({
    model: "qwen3.5:4b",
    baseUrl: "http://ollama.local:11434/",
    keepAlive: "5m",
    contextWindowTokens: 8192,
    fetch: async (input, init) => {
      expect(String(input)).toBe("http://ollama.local:11434/api/chat");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        done: true,
        message: { content: '{"queries":[" Alice city ","Alice move reason","ignored"]}' },
      });
    },
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
    fetch: async () => Response.json(payload),
  });

  await expect(provider.plan({ query: "query", maxQueries: 2 })).rejects.toThrow();
});
