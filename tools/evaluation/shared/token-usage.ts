interface UsageValueSummary {
  observedTotal: number;
  reportedCaseCount: number;
  total: number | null;
}

export interface TokenUsageSummary {
  caseCount: number;
  complete: boolean;
  input: UsageValueSummary;
  output: UsageValueSummary;
  total: UsageValueSummary;
}

function summarizeValues(values: Array<number | null>): UsageValueSummary {
  const reported = values.filter((value): value is number => value !== null);
  return {
    observedTotal: reported.reduce((total, value) => total + value, 0),
    reportedCaseCount: reported.length,
    total:
      reported.length === values.length && values.length > 0
        ? reported.reduce((total, value) => total + value, 0)
        : null,
  };
}

export function summarizeTokenUsage(
  values: Array<{
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }>,
): TokenUsageSummary {
  const input = summarizeValues(values.map((value) => value.inputTokens));
  const output = summarizeValues(values.map((value) => value.outputTokens));
  const total = summarizeValues(values.map((value) => value.totalTokens));
  return {
    caseCount: values.length,
    complete:
      values.length > 0 &&
      input.reportedCaseCount === values.length &&
      output.reportedCaseCount === values.length &&
      total.reportedCaseCount === values.length,
    input,
    output,
    total,
  };
}
