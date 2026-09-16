import type { PostgresTransaction } from "@corespeed/lore-core";
import {
  createPostgresDatabase as createCorePostgresDatabase,
  createRequestPostgresDatabase as createCoreRequestPostgresDatabase,
  type RuntimePostgresDatabase,
} from "@corespeed/lore-core/postgres";
import type { ClientConfig, PoolConfig } from "pg";

export type { RuntimePostgresDatabase } from "@corespeed/lore-core/postgres";

export type LoreDatabaseRole = "lore_app" | "lore_maintenance";

export interface PostgresDatabaseOptions {
  role?: LoreDatabaseRole;
}

function initializeRole(role: LoreDatabaseRole) {
  return async (transaction: PostgresTransaction): Promise<void> => {
    // The connection user must belong to this NOLOGIN role. SET LOCAL applies
    // RLS before domain operations and resets at COMMIT or ROLLBACK.
    switch (role) {
      case "lore_app":
        await transaction.query("SET LOCAL ROLE lore_app");
        return;
      case "lore_maintenance":
        await transaction.query("SET LOCAL ROLE lore_maintenance");
        return;
      default:
        throw new Error("Unsupported Lore database role");
    }
  };
}

export function createPostgresDatabase(
  config: PoolConfig,
  options: PostgresDatabaseOptions = {},
): RuntimePostgresDatabase {
  return createCorePostgresDatabase(config, {
    initializeTransaction: initializeRole(options.role ?? "lore_app"),
  });
}

export function createRequestPostgresDatabase(
  config: ClientConfig,
  options: PostgresDatabaseOptions = {},
): RuntimePostgresDatabase {
  return createCoreRequestPostgresDatabase(config, {
    initializeTransaction: initializeRole(options.role ?? "lore_app"),
  });
}
