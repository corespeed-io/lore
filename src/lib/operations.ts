import type { PostgresDatabase } from "./db";
import { observeOperation, runtimeDependencyStatus } from "./telemetry";

export const LORE_API_VERSION = "v1";
export const LORE_SCHEMA_REVISION = 2;

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
              `WITH required_rls_tables(table_name) AS (
                 VALUES
                   ('users'), ('workspaces'), ('memberships'), ('agents'),
                   ('agent_workspace_grants'), ('agent_credentials'), ('identities'),
                   ('memories'), ('memory_chunks'), ('memory_links'),
                   ('evaluation_suites'), ('evaluation_cases'), ('evaluation_runs'),
                   ('evaluation_results'), ('memory_embedding_jobs'),
                   ('request_idempotency_records'), ('memory_events'),
                   ('embedding_generations'), ('memory_chunk_embeddings'),
                   ('workspace_imports'), ('memory_import_provenance'),
                   ('memory_proposals'), ('memory_proposal_evidence'),
                   ('episodes'), ('observations'),
                   ('memory_proposal_observation_evidence'),
                   ('memory_proposal_code_evidence'),
                   ('code_repositories'), ('code_revisions'),
                   ('code_revision_files'), ('code_index_generations'),
                   ('code_index_jobs'), ('code_artifact_payloads'), ('code_artifacts'),
                   ('code_symbol_sets'), ('code_symbol_payloads'),
                   ('code_dependency_sets'), ('code_dependency_payloads'),
                   ('code_dependency_edges'),
                   ('memory_code_evidence')
               ), rls_state AS (
                 SELECT
                   count(relation.oid) = count(*)
                     AND bool_and(relation.relrowsecurity) AS enabled
                 FROM required_rls_tables required
                 LEFT JOIN pg_class relation
                   ON relation.oid = to_regclass('public.' || required.table_name)
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
              options.embeddingIdentity
                ? [
                    options.embeddingIdentity.provider,
                    options.embeddingIdentity.model,
                    options.embeddingIdentity.dimensions,
                    options.embeddingIdentity.revision,
                  ]
                : [null, null, null, null],
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
