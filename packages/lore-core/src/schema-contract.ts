import { EPISODE_KINDS, OBSERVATION_KINDS } from "./episodes/observations";
import { MEMORY_SCOPES } from "./memory-types";

/**
 * What the engine's SQL requires of one table.
 * - `columns`: every column it reads or writes.
 * - `inserts`: the columns its INSERTs name; every other NOT NULL column needs a
 *   default, identity, or generated value.
 * - `generated`: columns the host derives from the row (the lexical channels read
 *   them), as generated columns.
 * - `uniqueKeys`: column sets its ON CONFLICT clauses target.
 * - `cascades`: foreign keys that must delete this table's rows with their parent,
 *   because the engine deletes only the parent (for example on forget).
 */
export interface TableContract {
  columns: readonly string[];
  inserts?: readonly string[];
  generated?: readonly string[];
  uniqueKeys?: readonly (readonly string[])[];
  cascades?: readonly { column: string; parent: string }[];
}

/**
 * Everything one capability needs from its host schema. `types` names types by
 * name (for example pgvector's `vector`); `enums` requires exactly these labels;
 * `values` lists literals the engine compares a column with, which an enum column
 * must accept (a text column may hold anything); `settings` are transaction-local
 * GUCs the engine writes for the host's access policy to read.
 */
export interface SchemaContractGroup {
  tables: Readonly<Record<string, TableContract>>;
  functions: readonly string[];
  types: readonly string[];
  enums: Readonly<Record<string, readonly string[]>>;
  values: Readonly<Record<string, readonly string[]>>;
  settings: readonly string[];
}

const EMBEDDING_GENERATIONS: TableContract = {
  columns: [
    "id",
    "embedding_provider",
    "embedding_model",
    "embedding_dimensions",
    "embedding_revision",
    "status",
  ],
};

/**
 * The engine's whole storage dependency, grouped by the capability that needs it.
 * A host provides a group by satisfying every item in it.
 *
 * `tests/schema-contract.test.ts` holds the engine's SQL to this contract: every
 * table, `lore.*` function, setting, INSERT column list, and ON CONFLICT target the
 * source names must appear here (and every entry must still be used). Columns the
 * engine only reads are listed by hand. `missingSchemaContract` (`./testing`)
 * checks a host schema's catalog against the groups it provides.
 */
export const CORE_SCHEMA_CONTRACT = {
  /** Memory CRUD, chunking, and lexical and semantic retrieval, with no embedding provider. */
  memory: {
    tables: {
      memories: {
        columns: [
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
        inserts: [
          "id",
          "workspace_id",
          "owner_user_id",
          "created_by_agent_id",
          "scope",
          "content",
          "metadata",
        ],
      },
      memory_chunks: {
        columns: [
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
        inserts: ["id", "workspace_id", "memory_id", "ordinal", "content", "chunking_revision"],
        generated: ["search_vector", "search_vector_english", "entity_aliases"],
        cascades: [{ column: "memory_id", parent: "memories" }],
      },
      embedding_generations: EMBEDDING_GENERATIONS,
      memory_chunk_embeddings: {
        columns: ["generation_id", "workspace_id", "memory_id", "chunk_id", "embedding"],
        // An update replaces a Memory's chunks, and its vectors must go with them.
        cascades: [
          { column: "memory_id", parent: "memories" },
          { column: "chunk_id", parent: "memory_chunks" },
        ],
      },
    },
    functions: ["lore.extract_entity_aliases(text)"],
    types: ["vector"],
    enums: { memory_scope: MEMORY_SCOPES },
    values: { "embedding_generations.status": ["active", "retiring"] },
    settings: [],
  },
  /** Durable Memory Links and Graph reads. */
  graph: {
    tables: {
      memory_links: {
        columns: [
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
        inserts: [
          "id",
          "workspace_id",
          "source_memory_id",
          "target_memory_id",
          "kind",
          "weight",
          "metadata",
        ],
        uniqueKeys: [["workspace_id", "source_memory_id", "target_memory_id", "kind"]],
        cascades: [
          { column: "source_memory_id", parent: "memories" },
          { column: "target_memory_id", parent: "memories" },
        ],
      },
    },
    functions: [],
    types: [],
    enums: {},
    values: {},
    settings: [],
  },
  /**
   * Embedding jobs a write enqueues once an embedding provider is configured, their
   * leased maintenance, and embedding-generation rollout.
   */
  maintenance: {
    tables: {
      memory_chunk_embeddings: {
        columns: [
          "generation_id",
          "workspace_id",
          "memory_id",
          "chunk_id",
          "embedding",
          "embedded_at",
        ],
        inserts: [
          "generation_id",
          "workspace_id",
          "memory_id",
          "chunk_id",
          "embedding",
          "embedded_at",
        ],
        uniqueKeys: [["generation_id", "chunk_id"]],
      },
      memory_embedding_jobs: {
        columns: [
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
        inserts: [
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
        cascades: [{ column: "memory_id", parent: "memories" }],
      },
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
    types: ["vector"],
    enums: {},
    values: {},
    settings: ["lore.maintenance_job_id", "lore.maintenance_lease_token"],
  },
  /** The optional Episode/Observation evidence capability (`./episodes`). */
  episodes: {
    tables: {
      episodes: {
        columns: [
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
      },
      observations: {
        columns: [
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
        cascades: [{ column: "episode_id", parent: "episodes" }],
      },
      episode_evidence_chunks: {
        columns: [
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
        inserts: [
          "workspace_id",
          "episode_id",
          "observation_id",
          "observation_ordinal",
          "chunk_ordinal",
          "content",
          "index_revision",
        ],
        generated: ["search_vector", "search_vector_english"],
        uniqueKeys: [["workspace_id", "observation_id", "index_revision", "chunk_ordinal"]],
        cascades: [{ column: "episode_id", parent: "episodes" }],
      },
      episode_evidence_chunk_embeddings: {
        columns: [
          "generation_id",
          "workspace_id",
          "episode_id",
          "observation_id",
          "chunk_id",
          "embedding",
        ],
        inserts: [
          "generation_id",
          "workspace_id",
          "episode_id",
          "observation_id",
          "chunk_id",
          "embedding",
        ],
        uniqueKeys: [["generation_id", "chunk_id"]],
        cascades: [{ column: "chunk_id", parent: "episode_evidence_chunks" }],
      },
      embedding_generations: EMBEDDING_GENERATIONS,
    },
    functions: ["lore.ensure_embedding_generation(text,text,integer,text)"],
    types: ["vector"],
    enums: { episode_kind: EPISODE_KINDS, observation_kind: OBSERVATION_KINDS },
    values: { "embedding_generations.status": ["active", "retiring"] },
    settings: [],
  },
} as const satisfies Record<string, SchemaContractGroup>;

export type SchemaContractGroupName = keyof typeof CORE_SCHEMA_CONTRACT;
