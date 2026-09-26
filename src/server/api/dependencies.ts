import type { MemoryModuleOptions, PostgresDatabase } from "@corespeed/lore-core";
import type { AuthPrincipal } from "@/server/auth/auth";
import { createRequestContextResolver } from "@/server/auth/request-context";

/**
 * One operator-configured Code Repository (`LORE_CODE_REPOSITORIES`). Hosts inject
 * the registry the Code module parses; that module decides what each entry permits.
 */
export interface ConfiguredCodeRepository {
  displayName: string;
  repositoryPath: string;
  /**
   * Workspaces whose Actors may enqueue and index this repository. An entry
   * without this binding serves every Workspace, so
   * configuredCodeRepositoriesFromEnvironment keeps one only when the deployment
   * runs a single-operator auth mode (AUTH_MODE password or none).
   */
  workspaceIds?: readonly string[];
}

export type ConfiguredCodeRepositories = Readonly<Record<string, ConfiguredCodeRepository>>;

/** Hosts own database/provider lifetimes; routes resolve dependencies only when needed. */
export interface ApiDependencies {
  database(): PostgresDatabase | Promise<PostgresDatabase>;
  memoryOptions(): MemoryModuleOptions;
  codeRepositories(): ConfiguredCodeRepositories;
}

/**
 * Cache the host adapter within one request; identity is resolved only where handlers ask.
 * `principal` is the human credential admission already verified for this request.
 */
export function createRequestDependencies(
  dependencies: ApiDependencies,
  request: Request,
  principal?: AuthPrincipal,
) {
  let database: Promise<PostgresDatabase> | undefined;
  let resolver: ReturnType<typeof createRequestContextResolver> | undefined;
  function getDatabase() {
    database ??= Promise.resolve().then(() => dependencies.database());
    return database;
  }
  async function getResolver() {
    const database = await getDatabase();
    resolver ??= createRequestContextResolver(database);
    return resolver;
  }
  return {
    database: getDatabase,
    memoryOptions: () => dependencies.memoryOptions(),
    codeRepositories: () => dependencies.codeRepositories(),
    resolveActor: async () => (await getResolver()).resolveActor(request, principal),
    resolveUser: async () => (await getResolver()).resolveUser(request, principal),
  };
}

export type ApiEnv = { Variables: ReturnType<typeof createRequestDependencies> };
