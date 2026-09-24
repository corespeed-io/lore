/**
 * Whether an evaluation CLI must exit non-zero. An isolation/leak hard failure is
 * never a quality score to waive, so it fails the process with or without
 * `--strict`; `--strict` additionally enforces the quality thresholds.
 */
export function evaluationFailed(input: {
  strict: boolean;
  decision: string;
  hardFailureCount: number;
}): boolean {
  return input.hardFailureCount > 0 || (input.strict && input.decision !== "pass");
}
