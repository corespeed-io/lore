import type { PostgresDatabase } from "./db";
import { observeOperation, runtimeDependencyStatus } from "./telemetry";

export const LORE_API_VERSION = "v1";
export const LORE_SCHEMA_REVISION = 3;

export interface ReadinessReport {
  status: "degraded" | "ready" | "unready";
  components: {
    database: "ok" | "unavailable";
    embedding: "degraded" | "disabled" | "ok" | "unknown";
    rlsRole: "ok" | "unavailable";
    schema: "ok" | "incompatible" | "unavailable";
    vector: "ok" | "unavailable";
  };
}

interface ReadinessRow {
  capabilities: Record<string, unknown>;
  has_vector: boolean;
  role_name: string;
  rls_probe: boolean;
}

export function createOperationsModule(
  database: PostgresDatabase,
  options: { embeddingConfigured: boolean },
) {
  return {
    async capabilities(): Promise<Record<string, unknown>> {
      return observeOperation("operations.capabilities", () =>
        database.transaction(async (transaction) => {
          const result = await transaction.query<{ capabilities: Record<string, unknown> }>(
            "SELECT lore.portable_core_capabilities() AS capabilities",
          );
          const capabilities = result.rows[0]?.capabilities;
          if (!capabilities) throw new Error("Portable Core capabilities are unavailable");
          return capabilities;
        }),
      );
    },

    async readiness(): Promise<ReadinessReport> {
      const components: ReadinessReport["components"] = {
        database: "unavailable",
        embedding: options.embeddingConfigured
          ? runtimeDependencyStatus("embedding").status
          : "disabled",
        rlsRole: "unavailable",
        schema: "unavailable",
        vector: "unavailable",
      };
      try {
        const row = await observeOperation("operations.readiness", () =>
          database.transaction(async (transaction) => {
            await transaction.query("SELECT set_config('statement_timeout', '2000', true)");
            const result = await transaction.query<ReadinessRow>(
              `SELECT
                 lore.portable_core_capabilities() AS capabilities,
                 EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
                 current_user AS role_name,
                 lore.can_read_memory(
                   '00000000-0000-4000-8000-000000000000'::uuid,
                   '00000000-0000-4000-8000-000000000000'::uuid,
                   'private'::memory_scope
                 ) AS rls_probe`,
            );
            const value = result.rows[0];
            if (!value) throw new Error("Readiness query returned no result");
            return value;
          }),
        );
        components.database = "ok";
        components.vector = row.has_vector ? "ok" : "unavailable";
        components.rlsRole =
          row.role_name === "lore_app" && row.rls_probe === false ? "ok" : "unavailable";
        components.schema =
          Number(row.capabilities.schemaRevision) === LORE_SCHEMA_REVISION ? "ok" : "incompatible";
      } catch {
        // The response intentionally reports only bounded component states.
      }

      const ready =
        components.database === "ok" &&
        components.rlsRole === "ok" &&
        components.schema === "ok" &&
        components.vector === "ok";
      return {
        status: !ready ? "unready" : components.embedding === "degraded" ? "degraded" : "ready",
        components,
      };
    },
  };
}

export function livenessReport(): { status: "live" } {
  return { status: "live" };
}
