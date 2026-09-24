import type { ConfiguredCodeRepositories } from "@/modules/code/indexing/queue";
import { configuredCodeRepositoriesFromEnvironment } from "@/modules/code/indexing/queue";

/**
 * The maintenance worker's Code Repository registry. An invalid LORE_CODE_REPOSITORIES
 * (malformed JSON, an empty or non-UUID `workspaceIds`, an invalid entry) disables Code
 * Indexing in this worker instead of stopping it, so the retention sweep and embedding
 * loops keep running. The warning names only the error class: the registry's keys,
 * paths, and Workspaces never reach the log.
 */
export function codeRepositoriesForWorker(
  environment: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): ConfiguredCodeRepositories {
  try {
    return configuredCodeRepositoriesFromEnvironment(environment, warn);
  } catch (error) {
    const errorClass = error instanceof Error ? error.constructor.name : "NonErrorThrow";
    warn(
      `Lore disabled Code Indexing in this worker: LORE_CODE_REPOSITORIES is invalid (${errorClass})`,
    );
    return {};
  }
}
