import type { PostgresDatabase } from "@corespeed/lore-core";
import { observeOperation, runtimeDependencyStatus } from "@/server/telemetry/telemetry";

export const LORE_API_VERSION = "v1";
export const LORE_SCHEMA_REVISION = 4;

/**
 * The only public tables that hold no tenant data and so carry no RLS: the
 * deployment singleton and dbmate's migration ledger. Readiness requires RLS on
 * every other public table, so a table added by a later migration is covered
 * without editing a list. scripts/database/restore.ts keeps the same allowlist.
 */
export const NON_TENANT_PUBLIC_TABLES = ["lore_schema_migrations", "lore_system_state"] as const;

/**
 * Tenant tables the application reads and writes. Each must exist and enable RLS:
 * the catalog scan above cannot notice a table that a bad restore or manual change
 * dropped, and a missing table would otherwise pass readiness until a request hit
 * it. A test pins this list to the migrated schema's RLS tables, so a migration that
 * adds a tenant table fails until it is listed here and in scripts/database/restore.ts.
 */
export const REQUIRED_TENANT_TABLES = [
  "agent_credentials",
  "agents",
  "agent_workspace_grants",
  "code_artifact_payloads",
  "code_artifacts",
  "code_dependency_edges",
  "code_dependency_payloads",
  "code_dependency_sets",
  "code_index_generations",
  "code_index_jobs",
  "code_repositories",
  "code_revision_files",
  "code_revisions",
  "code_symbol_payloads",
  "code_symbol_sets",
  "embedding_generations",
  "episode_evidence_chunk_embeddings",
  "episode_evidence_chunks",
  "episodes",
  "evaluation_cases",
  "evaluation_results",
  "evaluation_runs",
  "evaluation_suites",
  "identities",
  "memberships",
  "memories",
  "memory_chunk_embeddings",
  "memory_chunks",
  "memory_code_evidence",
  "memory_embedding_jobs",
  "memory_events",
  "memory_import_provenance",
  "memory_links",
  "memory_proposal_code_evidence",
  "memory_proposal_evidence",
  "memory_proposal_observation_evidence",
  "memory_proposals",
  "observations",
  "request_idempotency_records",
  "users",
  "workspace_imports",
  "workspaces",
] as const;

export interface DeploymentCapabilities {
  apiVersion: "v1";
  schemaRevision: number;
  deploymentId: string;
  memoryChunking: {
    revision: string;
    maximumCharacters: number;
    overlapCharacters: number;
  };
  features: {
    idempotency: boolean;
    optimisticConcurrency: boolean;
    transactionalOutbox: boolean;
    workspacePortability: boolean;
    embeddingGenerations: boolean;
    cursorPagination: boolean;
    memoryProposals: boolean;
    observationEvidence: boolean;
    codeIndex: boolean;
    codeDependencies: boolean;
    codeEvidence: boolean;
  };
  limits: {
    memoryContentRecommendedCharacters: number;
    memoryContentMaximumCharacters: number;
    memoryMaximumChunks: number;
    workspaceArchiveMemories: number;
    workspaceArchiveLinks: number;
    memoryProposalEvidence: number;
    memoryProposalList: number;
    memoryProposalPending: number;
    memoryProposalRetentionSeconds: number;
    episodeObservations: number;
    episodeContentCharacters: number;
    episodeMetadataCharacters: number;
    observationContentCharacters: number;
    observationBatchRead: number;
    codeIndexFiles: number;
    codeIndexSourceBytes: number;
    codeIndexArtifacts: number;
    codeDependencyResults: number;
    codeSearchResults: number;
  };
  activeEmbeddingGeneration: {
    provider: string;
    model: string;
    dimensions: number;
    revision: string;
  } | null;
}

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
  embedding_matches: boolean;
  has_vector: boolean;
  role_name: string;
  rls_probe: boolean;
}

export interface OperationsOptions {
  embeddingConfigured: boolean;
  embeddingIdentity?: {
    dimensions: number;
    model: string;
    provider: string;
    revision: string;
  };
}

export function createOperationsModule(database: PostgresDatabase, options: OperationsOptions) {
  return {
    async capabilities(): Promise<DeploymentCapabilities> {
      return observeOperation("operations.capabilities", () =>
        database.transaction(async (transaction) => {
          const result = await transaction.query<{ capabilities: DeploymentCapabilities }>(
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
              `WITH required_tenant_state AS (
                 SELECT count(relation.oid) = count(*)
                   AND coalesce(bool_and(relation.relrowsecurity), false) AS present
                 FROM unnest($6::text[]) AS required(table_name)
                 LEFT JOIN pg_class relation
                   ON relation.oid = to_regclass('public.' || required.table_name)
               ), rls_state AS (
                 SELECT (SELECT present FROM required_tenant_state) AND NOT EXISTS (
                   SELECT 1
                   FROM pg_class relation
                   JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname = 'public'
                     AND relation.relkind IN ('r', 'p')
                     AND NOT relation.relrowsecurity
                     AND NOT (relation.relname = ANY ($5::text[]))
                 ) AS enabled
               ), runtime_role AS (
                 SELECT NOT role.rolsuper AND NOT role.rolbypassrls AS safe
                 FROM pg_roles role
                 WHERE role.rolname = current_user
               )
               SELECT
                 lore.portable_core_capabilities() AS capabilities,
                 CASE WHEN $1::text IS NULL THEN true ELSE EXISTS (
                   SELECT 1
                   FROM embedding_generations generation
                   WHERE generation.embedding_provider = $1
                     AND generation.embedding_model = $2
                     AND generation.embedding_dimensions = $3
                     AND generation.embedding_revision = $4
                     AND generation.status IN ('active', 'retiring')
                 ) END AS embedding_matches,
                 EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
                 current_user AS role_name,
                 (SELECT enabled FROM rls_state)
                   AND (SELECT safe FROM runtime_role)
                   AND current_setting('row_security') = 'on'
                   AND NULLIF(current_setting('lore.workspace_id', true), '') IS NULL
                   AND NULLIF(current_setting('lore.user_id', true), '') IS NULL
                   AND NULLIF(current_setting('lore.agent_id', true), '') IS NULL
                   AND NOT EXISTS (SELECT 1 FROM memories LIMIT 1) AS rls_probe`,
              [
                ...(options.embeddingIdentity
                  ? [
                      options.embeddingIdentity.provider,
                      options.embeddingIdentity.model,
                      options.embeddingIdentity.dimensions,
                      options.embeddingIdentity.revision,
                    ]
                  : [null, null, null, null]),
                [...NON_TENANT_PUBLIC_TABLES],
                [...REQUIRED_TENANT_TABLES],
              ],
            );
            const value = result.rows[0];
            if (!value) throw new Error("Readiness query returned no result");
            return value;
          }),
        );
        components.database = "ok";
        components.vector = row.has_vector ? "ok" : "unavailable";
        components.rlsRole =
          row.role_name === "lore_app" && row.rls_probe === true ? "ok" : "unavailable";
        components.schema =
          Number(row.capabilities.schemaRevision) === LORE_SCHEMA_REVISION ? "ok" : "incompatible";
        if (options.embeddingConfigured && !row.embedding_matches) {
          components.embedding = "degraded";
        }
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
