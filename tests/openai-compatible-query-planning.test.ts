import { createOpenAICompatibleQueryPlanningProvider } from "@corespeed/lore-core/providers";
import { expect, test } from "vitest";

test("OpenAI-compatible query planning requests JSON and returns bounded queries", async () => {
  const provider = createOpenAICompatibleQueryPlanningProvider({
    provider: "vllm",
    model: "Qwen/Qwen3-4B-Instruct",
    baseUrl: "http://planner.test/v1/",
    fetch: async (input, init) => {
      expect(String(input)).toBe("http://planner.test/v1/chat/completions");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
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
