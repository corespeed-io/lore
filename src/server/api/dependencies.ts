import type { MemoryModuleOptions, PostgresDatabase } from "@corespeed/lore-core";
import { admittedActor, type PendingActor, type PendingUser } from "@/server/auth/actor-admission";
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
  let actor: Promise<PendingActor> | undefined;
  let user: Promise<PendingUser> | undefined;
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
    /**
     * The request's Actor, admitted by the first transaction that binds it; every
     * caller in the request shares that one admission.
     */
    requestActor: () => {
      actor ??= getResolver().then((resolved) => resolved.requestActor(request, principal));
      return actor;
    },
    /** The admitted Actor, admitting it in a transaction of its own when still pending. */
    resolveActor: async () => {
      actor ??= getResolver().then((resolved) => resolved.requestActor(request, principal));
      return admittedActor(await getDatabase(), await actor);
    },
    /** The request's human, registered by the first transaction that binds it. */
    requestUser: () => {
      user ??= getResolver().then((resolved) => resolved.requestUser(request, principal));
      return user;
    },
    /** The registered User, registering it in a transaction of its own when still pending. */
    resolveUser: async () => {
      user ??= getResolver().then((resolved) => resolved.requestUser(request, principal));
      return (await user).resolve(await getDatabase());
    },
  };
}

export type ApiEnv = { Variables: ReturnType<typeof createRequestDependencies> };
