import { expect, test } from "vitest";
import { createGoogleQueryPlanningProvider } from "@/lib/query-planning/google";

test("Google query planning uses a non-stored structured interaction", async () => {
  const provider = createGoogleQueryPlanningProvider({
    model: "gemini-test",
    apiKey: "secret",
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-goog-api-key": "secret",
      });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "gemini-test",
        store: false,
        stream: false,
        generation_config: { temperature: 0 },
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: {
            properties: { queries: { maxItems: 2 } },
          },
        },
      });
      return Response.json({
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: '{"queries":["fact one","fact two"]}' }],
          },
        ],
      });
    },
  });

  await expect(provider.plan({ query: "Compare both events", maxQueries: 2 })).resolves.toEqual([
    "fact one",
    "fact two",
  ]);
});

test("Google query planning rejects incomplete interactions", async () => {
  const provider = createGoogleQueryPlanningProvider({
    model: "gemini-test",
    apiKey: "secret",
    fetch: async () => Response.json({ status: "incomplete", steps: [] }),
  });

  await expect(provider.plan({ query: "query", maxQueries: 2 })).rejects.toThrow(
    "incomplete interaction",
  );
});
