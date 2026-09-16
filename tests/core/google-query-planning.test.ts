import { createGoogleQueryPlanningProvider } from "@corespeed/lore-core/providers";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

test("Google query planning uses a non-stored structured interaction", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("x-goog-api-key")).toBe("secret");
    const body = await request.json();
    expect(body).toMatchObject({
      model: "gemini-test",
      store: false,
      stream: false,
      input: "Question: Compare both events\nMaximum retrieval queries: 2",
      generation_config: { temperature: 0, max_output_tokens: 256 },
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
  });
  const provider = createGoogleQueryPlanningProvider({
    model: "gemini-test",
    apiKey: "secret",
  });

  await expect(provider.plan({ query: "Compare both events", maxQueries: 2 })).resolves.toEqual([
    "fact one",
    "fact two",
  ]);
});

test("Google query planning rejects incomplete interactions", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ status: "incomplete", steps: [] }));
  const provider = createGoogleQueryPlanningProvider({
    model: "gemini-test",
    apiKey: "secret",
  });

  await expect(provider.plan({ query: "query", maxQueries: 2 })).rejects.toThrow(
    "incomplete interaction",
  );
});

test("Google query planning preserves custom API paths and instructions", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.url).toBe("http://localhost:8000/proxy/v1beta/interactions");
    expect(await request.json()).toMatchObject({ system_instruction: "Keep exact identifiers." });
    return Response.json({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: '{"queries":["query"]}' }] }],
    });
  });
  const provider = createGoogleQueryPlanningProvider({
    model: "gemini-test",
    apiKey: "secret",
    baseUrl: "http://localhost:8000/proxy/v1beta/",
    instruction: "Keep exact identifiers.",
  });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).resolves.toEqual(["query"]);
});

test("Google query planning leaves SDK retries disabled and hides HTTP error details", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: { message: "private upstream detail", code: 503 } }, { status: 503 }),
    );
  vi.stubGlobal("fetch", fetch);
  const provider = createGoogleQueryPlanningProvider({ model: "gemini-test", apiKey: "secret" });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).rejects.toThrow(
    /^Google query planner request failed with HTTP 503$/,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("Google query planning uses the SDK request timeout", async () => {
  const abort = vi.fn();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => {
          abort();
          reject(request.signal.reason);
        },
        { once: true },
      );
    });
  });
  const provider = createGoogleQueryPlanningProvider({
    model: "gemini-test",
    apiKey: "secret",
    timeoutMs: 10,
  });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).rejects.toThrow();
  expect(abort).toHaveBeenCalledTimes(1);
});

test("Google query planning rejects malformed query output", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: '{"queries":[42]}' }] }],
    }),
  );
  const provider = createGoogleQueryPlanningProvider({ model: "gemini-test", apiKey: "secret" });

  await expect(provider.plan({ query: "question", maxQueries: 1 })).rejects.toThrow(
    "invalid queries array",
  );
});
