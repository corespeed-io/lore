/**
 * Paired statistics and the pre-registered gate rule. Every comparison pairs the
 * same cases under the same reader and scorer, so sampling noise in questions
 * cancels and only the changed system shows.
 */

/** Exact two-sided McNemar p-value over discordant pairs. */
export function mcnemarExactP(wins: number, losses: number): number {
  const total = wins + losses;
  if (total === 0) return 1;
  const smaller = Math.min(wins, losses);
  // Binomial(total, 1/2) tail in log space: 2^total and C(total, k) leave
  // floating-point range past about 1,000 discordant pairs.
  let logTerm = -total * Math.LN2;
  let logTail = logTerm;
  for (let k = 1; k <= smaller; k++) {
    logTerm += Math.log((total - k + 1) / k);
    const top = Math.max(logTail, logTerm);
    logTail = top + Math.log(Math.exp(logTail - top) + Math.exp(logTerm - top));
  }
  return Math.min(1, 2 * Math.exp(logTail));
}

/** Deterministic paired bootstrap 95% interval of the mean delta (fixed LCG seed). */
export function pairedBootstrap95(deltas: readonly number[], samples = 10_000): [number, number] {
  if (!deltas.length) return [0, 0];
  let state = 20261012;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const draws = Array.from({ length: samples }, () =>
    mean(deltas.map(() => deltas[Math.floor(random() * deltas.length)] ?? 0)),
  ).sort((left, right) => left - right);
  return [draws[Math.floor(samples * 0.025)] ?? 0, draws[Math.floor(samples * 0.975) - 1] ?? 0];
}

/** Wilson 95% interval of a proportion. */
export function wilson95(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface PairedScore {
  caseId: string;
  category: string;
  base: number;
  candidate: number;
}

export interface Comparison {
  cases: number;
  baseMean: number;
  candidateMean: number;
  delta: number;
  interval95: [number, number];
  /** Binary scores only: cases the candidate fixed and broke. */
  wins: number;
  losses: number;
  /** Exact McNemar p for binary scores; null for continuous ones. */
  mcnemarP: number | null;
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function compare(pairs: readonly PairedScore[], binary: boolean): Comparison {
  const deltas = pairs.map((pair) => pair.candidate - pair.base);
  const wins = pairs.filter((pair) => pair.candidate > pair.base).length;
  const losses = pairs.filter((pair) => pair.candidate < pair.base).length;
  return {
    cases: pairs.length,
    baseMean: mean(pairs.map((pair) => pair.base)),
    candidateMean: mean(pairs.map((pair) => pair.candidate)),
    delta: mean(deltas),
    interval95: pairedBootstrap95(deltas),
    wins,
    losses,
    mcnemarP: binary ? mcnemarExactP(wins, losses) : null,
  };
}

export type Verdict = "improved" | "regressed" | "no-evidence";

export interface GateResult {
  verdict: Verdict;
  overall: Comparison;
  categories: Record<string, Comparison>;
  /** Categories the candidate made worse beyond the tolerance, named in the verdict. */
  regressedCategories: string[];
  reasons: string[];
}

/**
 * The pre-registered rule, fixed before any result is read:
 * - regressed: the overall loss is significant (interval below zero, and McNemar
 *   p < 0.05 for binary scores), or any isolation probe leaked;
 * - improved: the overall gain is significant the same way, and no category lost
 *   more than its tolerance (binary: three or more net losses; continuous: an
 *   interval wholly below zero);
 * - no-evidence otherwise. A change with no evidence is not an improvement.
 */
export function gate(
  pairs: readonly PairedScore[],
  binary: boolean,
  isolationFailures = 0,
): GateResult {
  const overall = compare(pairs, binary);
  const categories: Record<string, Comparison> = {};
  for (const category of [...new Set(pairs.map((pair) => pair.category))].sort()) {
    categories[category] = compare(
      pairs.filter((pair) => pair.category === category),
      binary,
    );
  }
  const regressedCategories = Object.entries(categories)
    .filter(([, result]) => (binary ? result.losses - result.wins >= 3 : result.interval95[1] < 0))
    .map(([category]) => category);
  const significant = (direction: 1 | -1) =>
    (direction > 0 ? overall.interval95[0] > 0 : overall.interval95[1] < 0) &&
    (!binary || (overall.mcnemarP ?? 1) < 0.05);
  const reasons: string[] = [];
  let verdict: Verdict = "no-evidence";
  if (isolationFailures > 0) {
    verdict = "regressed";
    reasons.push(`${isolationFailures} isolation failure(s)`);
  } else if (significant(-1)) {
    verdict = "regressed";
    reasons.push("significant overall loss");
  } else if (significant(1) && regressedCategories.length === 0) {
    verdict = "improved";
    reasons.push("significant overall gain with no category regression");
  } else if (significant(1)) {
    reasons.push(`overall gain, but categories regressed: ${regressedCategories.join(", ")}`);
  } else {
    reasons.push("the difference is within noise");
  }
  return { verdict, overall, categories, regressedCategories, reasons };
}
