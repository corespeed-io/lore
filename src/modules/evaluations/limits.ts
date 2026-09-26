import { MEMORY_SEARCH_LIMITS } from "@corespeed/lore-core";

/** Evaluation Suite bounds. A case query and limit are Memory search inputs. */
export const EVALUATION_LIMITS = {
  maximumCases: 1_000,
  maximumCaseMemoryIds: 100,
  maximumCaseQueryLength: MEMORY_SEARCH_LIMITS.maximumQueryLength,
  defaultCaseLimit: MEMORY_SEARCH_LIMITS.defaultLimit,
  maximumCaseLimit: MEMORY_SEARCH_LIMITS.maximumLimit,
  maximumNameLength: 120,
  maximumDescriptionLength: 10_000,
  defaultSuiteList: 50,
  maximumSuiteList: 100,
} as const;
