import "server-only";
import type { QueryPlanningProvider } from "@corespeed/lore-core";
import { createQueryPlanningProviderFromEnvironment } from "../query-planning/provider-factory";

let runtimeQueryPlanningProvider: QueryPlanningProvider | undefined;
let runtimeQueryPlanningProviderInitialized = false;

export function getRuntimeQueryPlanningProvider(
  env: Record<string, string | undefined> = process.env,
): QueryPlanningProvider | undefined {
  if (env !== process.env) {
    return createQueryPlanningProviderFromEnvironment(env, (message) => console.warn(message));
  }
  if (!runtimeQueryPlanningProviderInitialized) {
    runtimeQueryPlanningProvider = createQueryPlanningProviderFromEnvironment(
      process.env,
      (message) => console.warn(message),
    );
    runtimeQueryPlanningProviderInitialized = true;
  }
  return runtimeQueryPlanningProvider;
}

export function queryPlannerMaxQueriesFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env.LORE_QUERY_PLANNER_MAX_QUERIES;
  if (value === undefined || value.trim() === "") return 3;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) return parsed;
  console.warn("Lore query planner maximum queries must be an integer from 1 to 5; using 3");
  return 3;
}
