export interface AnswerEvaluationResult {
  correct: boolean | null;
  requiresJudge: boolean;
  judgeKind: "abstention" | "gotchas" | null;
  prediction: string;
  reference: string;
  evaluator: string;
}

export function extractBoxedAnswer(value: string): string {
  const marker = "\\boxed{";
  const start = value.lastIndexOf(marker);
  if (start < 0) return value.trim();
  let depth = 1;
  const contentStart = start + marker.length;
  for (let index = contentStart; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    if (value[index] === "}") depth -= 1;
    if (depth === 0) {
      const parsed = value.slice(contentStart, index).trim();
      return parsed || value.trim();
    }
  }
  return value.trim();
}

export function isUnknownLongMemEvalV2Answer(value: string): boolean {
  return extractBoxedAnswer(value).trim().toLocaleLowerCase("en-US") === "unknown";
}

function normalizePhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[‐‑‒–—―-]/g, " ")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function separators(evaluator: string): RegExp {
  const configured = evaluator.match(/(?:^|\|)separators=([^|]+)/)?.[1] ?? ",;";
  const escaped = [...configured].map((character) =>
    character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
  );
  return new RegExp(`[${escaped.join("")}]`);
}

function phrases(value: string, evaluator: string): string[] {
  return extractBoxedAnswer(value)
    .split(separators(evaluator))
    .map(normalizePhrase)
    .filter(Boolean);
}

function choice(value: string): string[] {
  const normalized = extractBoxedAnswer(value).toUpperCase();
  return normalized.match(/\b[A-H]\b/g) ?? [];
}

export function evaluateLongMemEvalV2Answer(input: {
  prediction: string;
  reference: string;
  evaluator: string;
}): AnswerEvaluationResult {
  const kind = input.evaluator.split("|", 1)[0];
  let correct: boolean | null;
  if (kind === "norm_phrase_set_match" || kind === "norm_phrase_set_match_ordered") {
    const predicted = phrases(input.prediction, input.evaluator);
    const expected = phrases(input.reference, input.evaluator);
    if (kind === "norm_phrase_set_match") {
      predicted.sort();
      expected.sort();
    }
    correct =
      predicted.length > 0 &&
      predicted.length === expected.length &&
      predicted.every((value, index) => value === expected[index]);
  } else if (kind === "mc_choice_match" || kind === "mc_choice_set_match") {
    const predicted = choice(input.prediction);
    const expected = choice(input.reference);
    if (kind === "mc_choice_set_match") {
      predicted.sort();
      expected.sort();
    }
    correct =
      predicted.length > 0 &&
      predicted.length === expected.length &&
      predicted.every((value, index) => value === expected[index]);
  } else if (kind === "llm_abstention_checker" || kind === "llm_gotchas_checker") {
    correct = null;
  } else {
    throw new Error(`Unsupported LongMemEval-V2 evaluator ${JSON.stringify(kind)}`);
  }
  return {
    correct,
    requiresJudge: correct === null,
    judgeKind:
      kind === "llm_abstention_checker"
        ? "abstention"
        : kind === "llm_gotchas_checker"
          ? "gotchas"
          : null,
    prediction: extractBoxedAnswer(input.prediction),
    reference: input.reference,
    evaluator: input.evaluator,
  };
}
