import { expect, test } from "vitest";
import {
  buildLongMemEvalV2JudgeMessages,
  createBenchmarkJudgeFromEnvironment,
  LONGMEMEVAL_V2_JUDGE_REVISION,
  parseLongMemEvalV2JudgeResponse,
} from "../scripts/lib/benchmark-judge";

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
