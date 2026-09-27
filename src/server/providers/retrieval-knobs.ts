import type { MemoryModuleOptions } from "@corespeed/lore-core";

/** The deployment-wide retrieval tuning a process reads from its environment. */
export type RetrievalKnobs = Required<
  Pick<
    MemoryModuleOptions,
    | "entityAliasRecall"
    | "evidenceNeighborChunks"
    | "evidenceTopChunks"
    | "queryPlannerMaxQueries"
    | "retrievalFeedbackQueries"
    | "retrievalRecencyWeight"
    | "rerankCandidateLimit"
    | "rerankDiversityLambda"
    | "rerankMinimumScore"
    | "rerankWeight"
    | "semanticDistanceThreshold"
  >
>;

type NumericKnob = Exclude<keyof RetrievalKnobs, "entityAliasRecall">;

interface NumericKnobSpec {
  variable: string;
  fallback: number;
  minimum: number;
  maximum: number;
  integer?: boolean;
  /** An empty value means zero rather than the default. */
  emptyIsZero?: boolean;
  /**
   * The server takes an invalid value without a warning: a value above the maximum
   * is clamped to it and any other invalid value uses the default. A benchmark still
   * refuses it.
   */
  lenient?: boolean;
}

export interface RetrievalKnobProblem {
  message: string;
  /** Whether the server warns about it; a benchmark refuses every problem. */
  warn: boolean;
}

/**
 * The one definition of every retrieval knob: its variable, default, and bounds.
 * The server and every benchmark runner read them through this table, so a
 * benchmark's default run is the deployment default.
 */
export const RETRIEVAL_KNOBS: Readonly<Record<NumericKnob, NumericKnobSpec>> = {
  evidenceNeighborChunks: {
    variable: "LORE_EVIDENCE_NEIGHBOR_CHUNKS",
    fallback: 0,
    minimum: 0,
    maximum: 2,
    integer: true,
    emptyIsZero: true,
  },
  evidenceTopChunks: {
    variable: "LORE_EVIDENCE_TOP_CHUNKS",
    fallback: 1,
    minimum: 1,
    maximum: 5,
    integer: true,
    emptyIsZero: true,
  },
  queryPlannerMaxQueries: {
    variable: "LORE_QUERY_PLANNER_MAX_QUERIES",
    fallback: 3,
    minimum: 1,
    maximum: 5,
    integer: true,
  },
  retrievalFeedbackQueries: {
    variable: "LORE_RETRIEVAL_FEEDBACK_QUERIES",
    fallback: 0,
    minimum: 0,
    maximum: 3,
    integer: true,
    emptyIsZero: true,
  },
  retrievalRecencyWeight: {
    variable: "LORE_RETRIEVAL_RECENCY_WEIGHT",
    fallback: 0,
    minimum: 0,
    maximum: 1,
  },
  rerankCandidateLimit: {
    variable: "LORE_RERANK_CANDIDATE_LIMIT",
    fallback: 50,
    minimum: 1,
    maximum: 200,
    integer: true,
    lenient: true,
  },
  rerankDiversityLambda: {
    variable: "LORE_RERANK_DIVERSITY_LAMBDA",
    fallback: 1,
    minimum: 0,
    maximum: 1,
  },
  rerankMinimumScore: { variable: "LORE_RERANK_MIN_SCORE", fallback: 0, minimum: 0, maximum: 1 },
  rerankWeight: { variable: "LORE_RERANK_WEIGHT", fallback: 1, minimum: 0, maximum: 1 },
  semanticDistanceThreshold: {
    variable: "LORE_SEMANTIC_DISTANCE_THRESHOLD",
    fallback: 0.5,
    minimum: 0,
    maximum: 2,
  },
};

type Environment = Readonly<Record<string, string | undefined>>;

function numericKnob(
  env: Environment,
  spec: NumericKnobSpec,
  problems: RetrievalKnobProblem[],
): number {
  const raw = env[spec.variable];
  if (raw === undefined || (!spec.emptyIsZero && !raw.trim())) return spec.fallback;
  const value = Number(raw);
  const shaped = spec.integer ? Number.isInteger(value) : Number.isFinite(value);
  const warn = !spec.lenient;
  if (shaped && spec.lenient && value > spec.maximum) {
    problems.push({
      message: `${spec.variable} must be at most ${spec.maximum}; using ${spec.maximum}`,
      warn,
    });
    return spec.maximum;
  }
  if (shaped && value >= spec.minimum && value <= spec.maximum) return value;
  problems.push({
    message: `${spec.variable} must be ${spec.integer ? "an integer " : ""}between ${spec.minimum} and ${spec.maximum}; using ${spec.fallback}`,
    warn,
  });
  return spec.fallback;
}

function entityAliasRecall(env: Environment, problems: RetrievalKnobProblem[]): boolean {
  const value = env.LORE_ENTITY_ALIAS_RECALL?.trim().toLowerCase();
  if (!value) return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  problems.push({
    message: "LORE_ENTITY_ALIAS_RECALL must be 0, 1, false, or true; entity recall is disabled",
    warn: true,
  });
  return false;
}

/**
 * Read every retrieval knob. An invalid value falls back to its default (or its
 * maximum, for a clamped knob) and is reported in `problems`: the server warns,
 * and a benchmark refuses to run on a configuration it would not measure.
 */
export function retrievalKnobsFromEnvironment(env: Environment): {
  knobs: RetrievalKnobs;
  problems: RetrievalKnobProblem[];
} {
  const problems: RetrievalKnobProblem[] = [];
  // RETRIEVAL_KNOBS is keyed by every numeric knob, so this rebuilds exactly that record.
  const numeric = Object.fromEntries(
    Object.entries(RETRIEVAL_KNOBS).map(([key, spec]) => [key, numericKnob(env, spec, problems)]),
  ) as Record<NumericKnob, number>;
  return { knobs: { ...numeric, entityAliasRecall: entityAliasRecall(env, problems) }, problems };
}

/** The knobs a benchmark runs with; any invalid value stops it before it starts. */
export function strictRetrievalKnobsFromEnvironment(env: Environment): RetrievalKnobs {
  const { knobs, problems } = retrievalKnobsFromEnvironment(env);
  if (problems.length > 0) throw new Error(problems.map((problem) => problem.message).join("; "));
  return knobs;
}
