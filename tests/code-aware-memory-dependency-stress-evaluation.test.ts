import { expect, test } from "vitest";
import { runCodeAwareMemoryDependencyStressEvaluation } from "../scripts/lib/code-aware-memory-dependency-stress-evaluation";
import { createMemoryTestContext } from "./support/memory-context";

test("dependency stress evaluation exercises semantic long-tail cases without hiding failures", async () => {
  const context = await createMemoryTestContext();
  const report = await runCodeAwareMemoryDependencyStressEvaluation(context);

  expect(report.revision).toBe("code-aware-memory-dependency-stress-v1");
  expect(report.summary.caseCount).toBe(16);
  expect(report.decision).toBe("pass");
  expect(report.cases.map((result) => result.id)).toEqual([
    "dependencies/aliased-import-call",
    "dependencies/barrel-reexport-call",
    "dependencies/default-import-call",
    "dependencies/namespace-import-call",
    "dependencies/aliased-type-reference",
    "dependencies/qualified-object-no-false-resolution",
    "dependencies/chunked-declaration",
    "dependencies/tsx-component-reference",
    "dependencies/javascript-import-call",
    "dependencies/static-method-call",
    "retrieval/sql-wildcard-literal",
    "retrieval/optional-chain-punctuation",
    "retrieval/cjk-literal",
    "retrieval/destructured-alpha",
    "retrieval/destructured-beta",
    "retrieval/malformed-source-fallback",
  ]);
  expect(report.cases.some((result) => result.observed.startsWith("error:"))).toBe(false);
  expect(report.cases.filter((result) => !result.passed).map((result) => result.id)).toEqual([]);
});
