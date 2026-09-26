import { EPISODE_KINDS, OBSERVATION_KINDS } from "./episodes/observations";
import { MEMORY_SCOPES } from "./memory-types";

/**
 * Everything the engine's SQL requires of its host schema, grouped by the
 * capability that needs it. A host provides a group by giving every listed table
 * the listed columns, every listed function its argument types, and every listed
 * enum exactly its labels. Settings are transaction-local GUCs the engine writes
 * for the host's access policy to read.
 *
 * `tests/schema-contract.test.ts` proves the engine's SQL names nothing outside
 * this contract; each host proves its schema provides the groups it uses.
 */
export interface SchemaContractGroup {
  tables: Readonly<Record<string, readonly string[]>>;
  functions: readonly string[];
  enums: Readonly<Record<string, readonly string[]>>;
  settings: readonly string[];
}

export const CORE_SCHEMA_CONTRACT = {
  /** Memory CRUD, chunking, and lexical and semantic retrieval, with no embedding provider. */
  memory: {
    tables: {
      memories: [
        "id",
        "workspace_id",
        "owner_user_id",
        "created_by_agent_id",
        "scope",
        "content",
        "metadata",
        "version",
        "created_at",
        "updated_at",
      ],
      memory_chunks: [
        "id",
        "workspace_id",
        "memory_id",
        "ordinal",
        "content",
        "chunking_revision",
        "search_vector",
        "search_vector_english",
        "entity_aliases",
      ],
      embedding_generations: [
        "id",
        "embedding_provider",
        "embedding_model",
        "embedding_dimensions",
        "embedding_revision",
        "status",
      ],
      memory_chunk_embeddings: [
        "generation_id",
        "workspace_id",
        "memory_id",
        "chunk_id",
        "embedding",
      ],
    },
    functions: ["lore.extract_entity_aliases(text)"],
    enums: { memory_scope: MEMORY_SCOPES },
    settings: [],
  },
  /** Durable Memory Links and Graph reads. */
  graph: {
    tables: {
      memory_links: [
        "id",
        "workspace_id",
        "source_memory_id",
        "target_memory_id",
        "kind",
        "weight",
        "metadata",
        "created_at",
        "updated_at",
      ],
    },
    functions: [],
    enums: {},
    settings: [],
  },
  /**
   * Embedding jobs a write enqueues once an embedding provider is configured, their
   * leased maintenance, and embedding-generation rollout.
   */
  maintenance: {
    tables: {
      memory_chunk_embeddings: [
        "generation_id",
        "workspace_id",
        "memory_id",
        "chunk_id",
        "embedding",
        "embedded_at",
      ],
      memory_embedding_jobs: [
        "id",
        "workspace_id",
        "memory_id",
        "owner_user_id",
        "memory_scope",
        "memory_version",
        "embedding_provider",
        "embedding_model",
        "embedding_revision",
        "generation_id",
      ],
    },
    functions: [
      "lore.activate_embedding_generation(text,text,text)",
      "lore.claim_memory_embedding_job(uuid,text,text,text,uuid,integer)",
      "lore.current_maintenance_generation_id()",
      "lore.embedding_generation_report(text,text,text)",
      "lore.enqueue_stale_memory_embedding_jobs(text,text,text,integer)",
      "lore.ensure_embedding_generation(text,text,integer,text)",
      "lore.finish_memory_embedding_job(uuid,uuid,text,integer)",
      "lore.list_pending_memory_embedding_jobs(text,text,text,integer,integer)",
      "lore.lock_current_maintenance_memory()",
      "lore.prune_retiring_embedding_generations(integer)",
    ],
    enums: {},
    settings: ["lore.maintenance_job_id", "lore.maintenance_lease_token"],
  },
  /** The optional Episode/Observation evidence capability (`./episodes`). */
  episodes: {
    tables: {
      episodes: [
        "id",
        "workspace_id",
        "owner_user_id",
        "recorded_by_actor_kind",
        "recorded_by_agent_id",
        "kind",
        "scope",
        "started_at",
        "ended_at",
        "created_at",
      ],
      observations: [
        "id",
        "workspace_id",
        "episode_id",
        "ordinal",
        "kind",
        "observed_at",
        "payload_sha256",
        "content",
        "metadata",
        "created_at",
      ],
      episode_evidence_chunks: [
        "id",
        "workspace_id",
        "episode_id",
        "observation_id",
        "observation_ordinal",
        "chunk_ordinal",
        "content",
        "index_revision",
        "search_vector",
        "search_vector_english",
        "created_at",
      ],
      episode_evidence_chunk_embeddings: [
        "generation_id",
        "workspace_id",
        "episode_id",
        "observation_id",
        "chunk_id",
        "embedding",
      ],
    },
    functions: ["lore.ensure_embedding_generation(text,text,integer,text)"],
    enums: { episode_kind: EPISODE_KINDS, observation_kind: OBSERVATION_KINDS },
    settings: [],
  },
} as const satisfies Record<string, SchemaContractGroup>;

export type SchemaContractGroupName = keyof typeof CORE_SCHEMA_CONTRACT;
