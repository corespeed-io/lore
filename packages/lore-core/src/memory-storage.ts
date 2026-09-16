import type { PostgresDatabase } from "./db";

/** Opaque storage keys. They carry attribution, never membership or permissions. */
export interface MemoryStorageScope {
  partitionId: string;
  ownerId: string;
  sourceId?: string;
}

/**
 * A host-bound store. Every transaction must already enforce the caller's access
 * policy before invoking its callback, including subsequent retrieval rounds.
 * Core never installs identity context or chooses database privileges.
 */
export interface MemoryStorageContext extends MemoryStorageScope {
  database: PostgresDatabase;
}
