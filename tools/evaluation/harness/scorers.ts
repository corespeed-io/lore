import { evaluateLocomoAnswer, type LocomoCategory } from "../retrieval/locomo";
import { type BoundJudge, LONGMEMEVAL_RUBRIC, longMemEvalRubricTemplates } from "./profiles";
import type { EvalCase, ScorerId } from "./types";

export interface Grade {
  score: number;
  label: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Scorer {
  id: ScorerId;
  /** Binary scores pair with McNemar; continuous ones with the bootstrap alone. */
  binary: boolean;
  /** Part of every verdict key. */
  identity: Record<string, unknown>;
  needsJudge: boolean;
  grade(evalCase: EvalCase, answer: string, judge: BoundJudge | undefined): Promise<Grade>;
}

/** LongMemEval's question-type rubric, filled exactly as evaluate_qa.py fills it. */
export function longMemEvalRubricPrompt(
  templates: readonly string[],
  evalCase: EvalCase,
  answer: string,
): string {
  const type = String(evalCase.scoring?.questionType ?? "");
  const index = evalCase.abstention
    ? 4
    : type === "temporal-reasoning"
      ? 1
      : type === "knowledge-update"
        ? 2
        : type === "single-session-preference"
          ? 3
          : 0;
  const values = [evalCase.question, evalCase.answer, answer];
  let at = 0;
  return (templates[index] ?? "").replace(/\{\}/g, () => values[at++] ?? "");
}

/** The rubric's strict verdict: exactly yes or no, with no trailing period. */
export function rubricVerdict(text: string): "yes" | "no" {
  const value = text.trim().toLowerCase().replace(/[.!]$/, "");
  if (value !== "yes" && value !== "no") {
    throw new Error(`Judge did not return yes/no: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return value;
}

export function createScorer(id: ScorerId): Scorer {
  if (id === "locomo-f1") {
    return {
      id,
      binary: false,
      identity: { scorer: id, revision: "locomo-nltk-porter-f1@3eb6f2c-v2" },
      needsJudge: false,
      async grade(evalCase, answer) {
        const score = evaluateLocomoAnswer({
          prediction: answer.trim(),
          reference: evalCase.answer,
          category: Number(evalCase.scoring?.locomoCategory) as LocomoCategory,
        });
        return { score, label: score.toFixed(4), inputTokens: null, outputTokens: null };
      },
    };
  }
  const templates = longMemEvalRubricTemplates();
  return {
    id,
    binary: true,
    identity: { scorer: id, rubric: LONGMEMEVAL_RUBRIC },
    needsJudge: true,
    async grade(evalCase, answer, judge) {
      if (!judge) throw new Error("longmemeval-judge-v1 needs a judge profile");
      const response = await judge.call(longMemEvalRubricPrompt(templates, evalCase, answer));
      const verdict = rubricVerdict(response.text);
      return {
        score: verdict === "yes" ? 1 : 0,
        label: verdict,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      };
    },
  };
}
