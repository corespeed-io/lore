import { expect, test, vi } from "vitest";
import {
  buildLongMemEvalV2JudgeMessages,
  createBenchmarkJudgeFromEnvironment,
  LONGMEMEVAL_V2_JUDGE_REVISION,
  parseLongMemEvalV2JudgeResponse,
} from "../../scripts/benchmarks/lib/benchmark-judge";

test("Google judge uses a non-stored SDK interaction and records usage", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(request.headers.get("x-goog-api-key")).toBe("test-key");
    expect(await request.json()).toMatchObject({
      model: "judge-model",
      store: false,
      stream: false,
      generation_config: { max_output_tokens: 4096 },
    });
    return Response.json({
      id: "judge-interaction",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: '{"label":1,"reason":"matches"}' }],
        },
      ],
      usage: { total_input_tokens: 20, total_output_tokens: 5, total_tokens: 25 },
    });
  });
  try {
    const judge = createBenchmarkJudgeFromEnvironment({
      LORE_BENCHMARK_JUDGE_PROVIDER: "google",
      LORE_BENCHMARK_JUDGE_MODEL: "judge-model",
      GEMINI_API_KEY: "test-key",
    });
    await expect(
      judge?.judge({
        kind: "gotchas",
        question: "Why?",
        referenceAnswer: "Because",
        modelFullResponse: "Because",
      }),
    ).resolves.toMatchObject({ correct: true, totalTokens: 25 });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});

test.each(["google", "openai"])(
  "%s judge hides upstream parser errors and does not retry",
  async (provider) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("private upstream text", {
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const judge = createBenchmarkJudgeFromEnvironment({
        LORE_BENCHMARK_JUDGE_PROVIDER: provider,
        LORE_BENCHMARK_JUDGE_MODEL: "judge-model",
        LORE_BENCHMARK_JUDGE_API_KEY: "test-key",
      });
      await expect(
        judge?.judge({
          kind: "gotchas",
          question: "Why?",
          referenceAnswer: "Because",
          modelFullResponse: "Because",
        }),
      ).rejects.toThrow(
        new Error(`${provider === "google" ? "Google " : ""}benchmark judge request failed`),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  },
);

test("LongMemEval-V2 judge prompt pins the official abstention rubric", () => {
  const messages = buildLongMemEvalV2JudgeMessages({
    kind: "abstention",
    question: "Which impossible setting is enabled?",
    referenceAnswer: "That setting does not exist.",
    modelFullResponse: "The premise is false. \\boxed{It does not exist.}",
    modelFinalAnswer: "It does not exist.",
  });

  expect(LONGMEMEVAL_V2_JUDGE_REVISION).toContain("ef67f10a");
  expect(messages[0].content).toContain("flawed-premise (abstention)");
  expect(messages[1].content).toContain("Label 0 for generic UNKNOWN");
  expect(messages[1].content).toContain("Model extracted final answer:\nIt does not exist.");
});

test("LongMemEval-V2 judge response parser matches strict JSON and official fallback", () => {
  expect(
    parseLongMemEvalV2JudgeResponse('```json\n{"label": 1, "reason": "matches"}\n```'),
  ).toEqual({
    label: 1,
    reason: "matches",
  });
  expect(parseLongMemEvalV2JudgeResponse("label: 0 because it contradicts the reference")).toEqual({
    label: 0,
    reason: "label: 0 because it contradicts the reference",
  });
});

test("vLLM judge sends the official protocol and records its separate token cost", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe("http://judge.test/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "judge-model",
      max_completion_tokens: 4096,
      reasoning_effort: "medium",
    });
    expect(body.messages[0].content).toContain("gotchas-style insight questions");
    return Response.json({
      choices: [{ message: { content: '{"label": 1, "reason": "one insight matches"}' } }],
      usage: { prompt_tokens: 210, completion_tokens: 12, total_tokens: 222 },
    });
  };
  try {
    const judge = createBenchmarkJudgeFromEnvironment({
      LORE_BENCHMARK_JUDGE_PROVIDER: "vllm",
      LORE_BENCHMARK_JUDGE_MODEL: "judge-model",
      LORE_BENCHMARK_JUDGE_BASE_URL: "http://judge.test/v1",
    });
    await expect(
      judge?.judge({
        kind: "gotchas",
        question: "What is the catch?",
        referenceAnswer: "The button only changes local state.",
        modelFullResponse: "\\boxed{It only changes local state.}",
      }),
    ).resolves.toMatchObject({
      correct: true,
      label: 1,
      reason: "one insight matches",
      inputTokens: 210,
      outputTokens: 12,
      totalTokens: 222,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
