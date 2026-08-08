import { expect, test } from "vitest";
import {
  evaluateLongMemEvalV2Answer,
  extractBoxedAnswer,
  isUnknownLongMemEvalV2Answer,
} from "@/lib/answer-evaluation";

test("boxed answer extraction handles nested braces", () => {
  expect(extractBoxedAnswer("reasoning \\boxed{Reports; {Problems}} trailing")).toBe(
    "Reports; {Problems}",
  );
});

test("boxed extraction matches the official empty-box fallback and exact UNKNOWN check", () => {
  expect(extractBoxedAnswer("Reasoning \\boxed{}")).toBe("Reasoning \\boxed{}");
  expect(isUnknownLongMemEvalV2Answer("Reasoning \\boxed{UNKNOWN}")).toBe(true);
  expect(isUnknownLongMemEvalV2Answer("unknown because evidence is missing")).toBe(false);
});

test("phrase-set evaluation normalizes punctuation and ignores order when requested", () => {
  expect(
    evaluateLongMemEvalV2Answer({
      prediction: "\\boxed{My Open-Incidents; Incident Portal, Incident Mobile}",
      reference: "Incident Mobile, Incident Portal, My Open Incidents",
      evaluator:
        "norm_phrase_set_match|lower=true|normalize_hyphen=true|strip_punct=true|separators=,;|require_non_empty=true",
    }).correct,
  ).toBe(true);
});

test("ordered phrase and multiple-choice evaluation preserve required order", () => {
  expect(
    evaluateLongMemEvalV2Answer({
      prediction: "\\boxed{Problems; Reports}",
      reference: "Reports;Problems",
      evaluator:
        "norm_phrase_set_match_ordered|lower=true|normalize_hyphen=true|strip_punct=true|separators=;|require_non_empty=true",
    }).correct,
  ).toBe(false);
  expect(
    evaluateLongMemEvalV2Answer({
      prediction: "The answer is \\boxed{G}.",
      reference: "G",
      evaluator: "mc_choice_match|require_non_empty=true",
    }).correct,
  ).toBe(true);
});

test("judge-based evaluators remain explicitly unresolved", () => {
  expect(
    evaluateLongMemEvalV2Answer({
      prediction: "\\boxed{No such field exists}",
      reference: "There is no such field.",
      evaluator: "llm_abstention_checker|require_non_empty=true",
    }),
  ).toMatchObject({ correct: null, requiresJudge: true, judgeKind: "abstention" });
});
