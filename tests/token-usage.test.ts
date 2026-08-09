import { expect, test } from "vitest";
import { summarizeTokenUsage } from "../scripts/lib/token-usage";

test("token usage totals are nullable when provider coverage is incomplete", () => {
  expect(
    summarizeTokenUsage([
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      { inputTokens: null, outputTokens: null, totalTokens: null },
    ]),
  ).toEqual({
    caseCount: 2,
    complete: false,
    input: { observedTotal: 10, reportedCaseCount: 1, total: null },
    output: { observedTotal: 2, reportedCaseCount: 1, total: null },
    total: { observedTotal: 12, reportedCaseCount: 1, total: null },
  });
});

test("token usage reports complete totals only with full coverage", () => {
  expect(
    summarizeTokenUsage([
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    ]),
  ).toMatchObject({
    caseCount: 2,
    complete: true,
    input: { observedTotal: 15, reportedCaseCount: 2, total: 15 },
    output: { observedTotal: 3, reportedCaseCount: 2, total: 3 },
    total: { observedTotal: 18, reportedCaseCount: 2, total: 18 },
  });
});
