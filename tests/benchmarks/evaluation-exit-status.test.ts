import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { evaluationFailed } from "../../tools/evaluation/shared/evaluation-exit-status";

test("an isolation hard failure fails the evaluation with or without --strict", () => {
  for (const strict of [false, true]) {
    expect(evaluationFailed({ strict, decision: "fail", hardFailureCount: 1 })).toBe(true);
    // A hard failure is never waived, even by a report that claims to pass.
    expect(evaluationFailed({ strict, decision: "pass", hardFailureCount: 2 })).toBe(true);
  }
});

test("--strict alone turns a missed quality threshold into a failure", () => {
  expect(evaluationFailed({ strict: false, decision: "fail", hardFailureCount: 0 })).toBe(false);
  expect(evaluationFailed({ strict: true, decision: "fail", hardFailureCount: 0 })).toBe(true);
  expect(evaluationFailed({ strict: true, decision: "pass", hardFailureCount: 0 })).toBe(false);
});

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const foundation = "tools/evaluation/code/evaluate-code-aware-memory.ts";
const joint = "tools/evaluation/context/evaluate-joint-memory-code.ts";

function runEvaluation(entrypoint: string, initialExitCode?: number) {
  const command =
    initialExitCode === undefined
      ? [entrypoint, "--strict"]
      : [
          "--eval",
          `process.exitCode = ${initialExitCode};
           process.argv = [process.execPath, ${JSON.stringify(entrypoint)}, "--strict"];
           await import(${JSON.stringify(`./${entrypoint}`)});`,
        ];
  const result = spawnSync(process.execPath, ["--no-env-file", ...command], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  return result;
}

test.each([foundation, joint])("a passing %s exits successfully", (entrypoint) => {
  const result = runEvaluation(entrypoint);
  expect(JSON.parse(result.stdout).decision).toBe("pass");
  expect(result.status, result.stderr).toBe(0);
});

test("evaluation startup and database cleanup preserve an existing failure status", () => {
  const result = runEvaluation(foundation, 7);
  expect(JSON.parse(result.stdout).decision).toBe("pass");
  expect(result.status, result.stderr).toBe(7);
});
