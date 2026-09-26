import type { MemoryMaintenanceNotifier, MemoryModuleOptions } from "@corespeed/lore-core";
import { EMBEDDING_DIMENSIONS } from "./embedding/config";
import { createEmbeddingProviderFromEnvironment } from "./embedding/factory";
import { createQueryPlanningProviderFromEnvironment } from "./query-planning/factory";
import { createRerankingProviderFromEnvironment } from "./reranking/factory";
import { retrievalKnobsFromEnvironment } from "./retrieval-knobs";

/**
 * Every deployment-wide option except the request-scoped maintenance notifier.
 * The environment is read once per process, next to the providers it configures,
 * so an invalid knob warns once instead of on every request.
 */
type RuntimeDeploymentOptions = Omit<MemoryModuleOptions, "maintenanceNotifier">;

let runtimeDeploymentOptions: RuntimeDeploymentOptions | undefined;

const warn = (message: string) => console.warn(message);

function runtimeDeploymentOptionsFromEnvironment(): RuntimeDeploymentOptions {
  const { knobs: retrievalKnobs, problems } = retrievalKnobsFromEnvironment(process.env);
  for (const problem of problems) if (problem.warn) warn(problem.message);
  return {
    embeddingProvider: createEmbeddingProviderFromEnvironment(process.env, warn),
    queryPlanningProvider: createQueryPlanningProviderFromEnvironment(process.env, warn),
    rerankingProvider: createRerankingProviderFromEnvironment(process.env, warn),
    // Lore v1 protocol invariant: the baseline schema is built for 1024.
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    ...retrievalKnobs,
  };
}

export function getRuntimeMemoryModuleOptions(
  options: { maintenanceNotifier?: MemoryMaintenanceNotifier } = {},
): MemoryModuleOptions {
  runtimeDeploymentOptions ??= runtimeDeploymentOptionsFromEnvironment();
  return { ...runtimeDeploymentOptions, maintenanceNotifier: options.maintenanceNotifier };
}
