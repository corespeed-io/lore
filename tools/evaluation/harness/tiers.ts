import { createHash } from "node:crypto";
import type { DatasetCaseIndex } from "./types";

/**
 * Fixed, stratified samples. A case's place in its category is its SHA-256 order,
 * never its outcome, so a tier holds the same questions on every run and branch.
 */
export const TIERS = {
  /** Retrieval only: a few questions per category, no reader. */
  smoke: { perCategory: 5, answer: false },
  /** Question answering on a stratified sample. */
  standard: { perCategory: 20, answer: true },
  /** Every question. */
  full: { perCategory: Number.POSITIVE_INFINITY, answer: true },
} as const;
export type TierName = keyof typeof TIERS;

export function isTier(value: string | undefined): value is TierName {
  return value !== undefined && Object.hasOwn(TIERS, value);
}

const order = (id: string) => createHash("sha256").update(id).digest("hex");

export function selectTier(
  index: readonly DatasetCaseIndex[],
  tier: TierName,
  perCategory: number = TIERS[tier].perCategory,
): Set<string> {
  const byCategory = new Map<string, DatasetCaseIndex[]>();
  for (const entry of index) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const selected = new Set<string>();
  for (const entries of byCategory.values()) {
    for (const entry of entries
      .sort((left, right) => order(left.id).localeCompare(order(right.id)))
      .slice(0, perCategory)) {
      selected.add(entry.id);
    }
  }
  return selected;
}
