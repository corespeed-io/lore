import type { MemoryModuleOptions, PostgresDatabase } from "@corespeed/lore-core";
import type { ConfiguredCodeRepositories } from "@/modules/code/indexing/queue";
import { createRequestContextResolver } from "@/server/auth/request-context";

/** Hosts own database/provider lifetimes; routes resolve dependencies only when needed. */
export interface ApiDependencies {
  database(): PostgresDatabase | Promise<PostgresDatabase>;
  memoryOptions(): MemoryModuleOptions;
  codeRepositories(): ConfiguredCodeRepositories;
}

/** Cache the host adapter within one request; identity is resolved only where handlers ask. */
export function createRequestDependencies(dependencies: ApiDependencies, request: Request) {
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
    resolveActor: async () => (await getResolver()).resolveActor(request),
    resolveUser: async () => (await getResolver()).resolveUser(request),
  };
}

export type ApiEnv = { Variables: ReturnType<typeof createRequestDependencies> };
